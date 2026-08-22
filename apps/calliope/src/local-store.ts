/**
 * The local engine store (spec 046, master-plan F14) — the desktop's ONE
 * body backend, replacing the fs backend and everything built to
 * compensate for it (file-derived sections, the computed tag module, the
 * revlog, the sqlite search index).
 *
 * The model: the ENGINE (baby chaos, F13) is the store; the markdown
 * directory is the WORKING TREE — a projection the store writes and other
 * apps may edit. Sections come from the graph's tree (slot tokens are the
 * durable identity the fs grain never had); history is the graph read
 * as-of a transaction; search is the engine's own postgres (tsvector —
 * Rob's decision: Eros stays local via tsvector + pgvector); tags remain
 * a computed walk of the working tree (the desktop mints no hasTag facts —
 * extraction reads file text only and derives no sections).
 *
 * External edits reconcile like `git add`: a file whose text differs from
 * its projection INGESTS on read (lazy capture — the fs revlog's own
 * invalidation model, inherited), and a watcher sweeps the tree so search
 * stays fresh between reads. An externally edited body lands as ONE block:
 * the block grain is user-determined and a foreign editor states no
 * boundaries — a note is one block until the user splits it (the 0.14
 * de-inference rule, outliving the backend it was written for).
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FSWatcher } from "node:fs";
import { watch } from "node:fs";
import * as path from "node:path";
import type { Pool } from "pg";
import { containerHistory, readContainer } from "./container-read.js";
import type { ContainerBlock } from "./container-read.js";
import { type ContainerFacet, writeContainer } from "./container-write.js";
import type { ContainerOp } from "./container-write.js";
import { bodyDiffOps } from "./container-body.js";
import { opCreate } from "./chaos-client.js";
import { sequence } from "./order-key.js";
import type {
  Mention,
  MentionsResponse,
  SearchArm,
  SearchHit,
  SearchResponse,
} from "./search-types.js";
import { extractInlineTags, normalizeTag } from "./tags.js";
import type { TagCount } from "./tag-store.js";
import type {
  AppliedOp,
  ApplySectionOpsResult,
  BodyClient,
  RevisionMeta,
  Section,
  SectionInput,
  SectionOp,
} from "./types.js";

/** The editor's block separator — the JOIN seam of the projection. */
const SECTION_SEP = "\n\n";

/** Extensions the body layer serves; everything else is not a body. */
const SERVED_EXTENSIONS = new Set([".md", ".markdown"]);

const ARM_DEPTH = 128;
const DEFAULT_K = 20;

/** The local search index DDL — lives in the ENGINE's own postgres
 *  (calliope database), beside the blob store. */
const SEARCH_SQL = `
CREATE TABLE IF NOT EXISTS local_search (
  path  text PRIMARY KEY,
  title text NOT NULL,
  body  text NOT NULL,
  tsv   tsvector GENERATED ALWAYS AS
        (to_tsvector('english', title || ' ' || body)) STORED
);
CREATE INDEX IF NOT EXISTS local_search_tsv
  ON local_search USING GIN (tsv);
CREATE TABLE IF NOT EXISTS local_links (
  path   text NOT NULL,
  target text NOT NULL,
  PRIMARY KEY (path, target)
);
CREATE INDEX IF NOT EXISTS local_links_target ON local_links (target);
`;

/** Wikilink targets, lowercased basenames — the F11 linked-mentions seam. */
export function extractWikilinks(text: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\][|#\n]+)(?:#[^\][|\n]*)?(?:\|[^\][\n]*)?\]\]/g;
  let match = re.exec(text);
  while (match !== null) {
    const raw = (match[1] ?? "").trim();
    if (raw !== "") {
      const base = raw.split("/").pop() ?? raw;
      out.push(base.toLowerCase().replace(/\.(md|markdown)$/, ""));
    }
    match = re.exec(text);
  }
  return out;
}

function titleOf(nodeId: string): string {
  const base = nodeId.split("/").pop() ?? nodeId;
  return base.replace(/\.(md|markdown)$/i, "");
}

function clip(text: string, max = 240): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

async function walkTree(
  root: string,
  dir: string,
  out: string[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // a vanished subdirectory mid-scan is not an error
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // .obsidian, .grace, .git …
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkTree(root, abs, out);
    } else if (
      entry.isFile() &&
      SERVED_EXTENSIONS.has(path.extname(entry.name.toLowerCase()))
    ) {
      out.push(abs);
    }
  }
}

export interface LocalStoreOptions {
  /** The engine's postgres — the search index home. Null = search dark
   *  (fixture tests); reads/writes/tags need no pool. */
  pool?: Pool | null;
  /** Test seam: disable the watcher. */
  watch?: boolean;
  /** Test seam: watcher debounce ms (default 300). */
  debounceMs?: number;
}

/**
 * The desktop {@link BodyClient} over the local engine: node identity is
 * the root-relative markdown path; the container is the graph node
 * LABELLED by that path (minted on first write); blocks are the sections.
 */
export class LocalEngineStore implements BodyClient {
  readonly #root: string;
  readonly #facet: ContainerFacet;
  readonly #pool: Pool | null;
  readonly #debounceMs: number;
  /** path → container token (label lookups are stable; cache is safe). */
  readonly #containers = new Map<string, string>();
  /** Per-path write serialization: the tail of each path's op chain. */
  readonly #locks = new Map<string, Promise<unknown>>();
  /** sha256 of the text this store last projected per path — the "did an
   *  outside hand touch this file" comparator. */
  readonly #projected = new Map<string, string>();
  #watcher: FSWatcher | null = null;
  #searchReady: Promise<void> | null = null;
  readonly #pending = new Map<string, NodeJS.Timeout>();

  constructor(root: string, facet: ContainerFacet, opts?: LocalStoreOptions) {
    this.#root = path.resolve(root);
    this.#facet = facet;
    this.#pool = opts?.pool ?? null;
    this.#debounceMs = opts?.debounceMs ?? 300;
    if (opts?.watch !== false) {
      try {
        this.#watcher = watch(
          this.#root,
          { recursive: true },
          (_event, name) => {
            if (typeof name === "string") this.#noteChanged(name);
          },
        );
        this.#watcher.on("error", () => {
          this.#watcher = null; // reads still ingest lazily
        });
      } catch {
        this.#watcher = null;
      }
    }
  }

  get root(): string {
    return this.#root;
  }

  /** The engine facet — the /mcp container verbs ride the same one. */
  get facet(): ContainerFacet {
    return this.#facet;
  }

  close(): void {
    this.#watcher?.close();
    for (const timer of this.#pending.values()) clearTimeout(timer);
    this.#pending.clear();
  }

  /** Boot catch-up: ingest every served file that drifted from the engine
   *  (first run: everything — the working tree seeds the store). */
  async scan(): Promise<void> {
    const files: string[] = [];
    await walkTree(this.#root, this.#root, files);
    for (const abs of files.sort()) {
      const nodeId = path.relative(this.#root, abs).split(path.sep).join("/");
      try {
        await this.#serialized(abs, () => this.#ingest(nodeId, abs));
      } catch {
        // one bad file must not sink the scan; the next read retries it
      }
    }
  }

  // ── path discipline (the fs backend's rules, verbatim) ─────────────────

  #resolve(nodeId: string): string {
    if (nodeId === "" || nodeId.includes("\0")) {
      throw new Error(`invalid_path: empty or malformed node id.`);
    }
    const ext = path.posix.extname(nodeId.toLowerCase());
    if (!SERVED_EXTENSIONS.has(ext)) {
      throw new Error(
        `unsupported_file: ${nodeId} is not a markdown body (.md/.markdown).`,
      );
    }
    const abs = path.resolve(this.#root, nodeId);
    const rel = path.relative(this.#root, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`invalid_path: ${nodeId} escapes the served root.`);
    }
    return abs;
  }

  #serialized<T>(abs: string, work: () => Promise<T>): Promise<T> {
    const tail = this.#locks.get(abs) ?? Promise.resolve();
    const next = tail.then(work, work);
    this.#locks.set(
      abs,
      next.catch(() => undefined),
    );
    return next;
  }

  // ── container resolution ───────────────────────────────────────────────

  async #container(nodeId: string): Promise<string> {
    const cached = this.#containers.get(nodeId);
    if (cached !== undefined) return cached;
    const existing = await this.#facet.dial.findByName("node", nodeId);
    let token = existing[0];
    if (token === undefined) {
      const res = await this.#facet.dial.admit(
        [opCreate("node", nodeId)],
        "notes",
      );
      token = res.minted[0];
      if (token === undefined) {
        throw new Error(`store_error: could not mint a container: ${nodeId}`);
      }
    }
    this.#containers.set(nodeId, token);
    return token;
  }

  async #blocks(nodeId: string): Promise<ContainerBlock[]> {
    const container = await this.#container(nodeId);
    return (await readContainer(this.#facet, container)).blocks;
  }

  // ── the working tree: projection + ingestion ───────────────────────────

  #projectionOf(blocks: ContainerBlock[]): string {
    return blocks.map((b) => b.text ?? "").join(SECTION_SEP);
  }

  async #project(nodeId: string, abs: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = path.join(
      path.dirname(abs),
      `.calliope-tmp-${process.pid.toString(36)}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, abs);
    this.#projected.set(nodeId, sha(text));
    await this.#index(nodeId, text);
  }

  /** Reconcile one file into the engine when it drifted — `git add`, run
   *  lazily. Returns the container's current blocks (post-ingest). */
  async #ingest(nodeId: string, abs: string): Promise<ContainerBlock[]> {
    let raw: Buffer | null;
    try {
      raw = await fs.readFile(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      raw = null;
    }
    const fileText =
      raw === null ? null : raw.toString("utf8").replace(/\r\n?/g, "\n");
    const blocks = await this.#blocks(nodeId);
    const projected = this.#projectionOf(blocks);

    if (fileText === null) {
      // The working-tree file is gone. An empty container agrees; a
      // non-empty one follows the tree (deletion is a working-tree edit —
      // recoverable from history, like any git deletion).
      if (blocks.length === 0) return blocks;
      const ops: ContainerOp[] = blocks
        .filter((b) => b.blobId !== null)
        .map((b) => ({
          op: "remove",
          slot: b.slot,
          position: b.position,
          blobId: b.blobId ?? "",
        }));
      if (ops.length === 0) return blocks;
      const container = await this.#container(nodeId);
      await writeContainer(this.#facet, container, ops, "notes");
      await this.#unindex(nodeId);
      return [];
    }

    if (fileText === projected && blocks.length > 0) {
      await this.#index(nodeId, fileText);
      return blocks;
    }
    if (fileText === "" && blocks.length === 0) return blocks;
    if (fileText === projected) return blocks;

    // Drift: the outside edit lands as ONE block (boundaries are
    // user-stated; a foreign editor states none).
    const container = await this.#container(nodeId);
    const ops: ContainerOp[] = [];
    const first = blocks[0];
    if (first === undefined) {
      const key = sequence(1)[0] ?? "a0";
      if (fileText !== "") {
        ops.push({ op: "add", text: fileText, position: key });
      }
    } else {
      if (fileText === "") {
        ops.push(
          ...blocks
            .filter((b) => b.blobId !== null)
            .map((b): ContainerOp => ({
              op: "remove",
              slot: b.slot,
              position: b.position,
              blobId: b.blobId ?? "",
            })),
        );
      } else {
        ops.push({
          op: "update",
          slot: first.slot,
          oldBlobId: first.blobId ?? "",
          text: fileText,
        });
        ops.push(
          ...blocks
            .slice(1)
            .filter((b) => b.blobId !== null)
            .map((b): ContainerOp => ({
              op: "remove",
              slot: b.slot,
              position: b.position,
              blobId: b.blobId ?? "",
            })),
        );
      }
    }
    if (ops.length > 0) {
      await writeContainer(this.#facet, container, ops, "notes");
    }
    this.#projected.set(nodeId, sha(fileText));
    await this.#index(nodeId, fileText);
    return this.#blocks(nodeId);
  }

  #noteChanged(rel: string): void {
    const nodeId = rel.split(path.sep).join("/");
    if (nodeId.split("/").some((s) => s.startsWith("."))) return;
    if (!SERVED_EXTENSIONS.has(path.posix.extname(nodeId.toLowerCase())))
      return;
    const prior = this.#pending.get(nodeId);
    if (prior !== undefined) clearTimeout(prior);
    this.#pending.set(
      nodeId,
      setTimeout(() => {
        this.#pending.delete(nodeId);
        const abs = path.resolve(this.#root, nodeId);
        void this.#serialized(abs, () => this.#ingest(nodeId, abs)).catch(
          () => undefined, // the next read retries; darkness is not fatal
        );
      }, this.#debounceMs),
    );
  }

  // ── BodyClient ─────────────────────────────────────────────────────────

  async readBody(nodeId: string): Promise<Section[]> {
    const abs = this.#resolve(nodeId);
    const blocks = await this.#serialized(abs, () => this.#ingest(nodeId, abs));
    return blocks.map((b) => ({
      id: b.slot,
      text: b.text ?? "",
      orderKey: b.position,
    }));
  }

  async saveBody(nodeId: string, sections: SectionInput[]): Promise<void> {
    const abs = this.#resolve(nodeId);
    await this.#serialized(abs, async () => {
      const blocks = await this.#ingest(nodeId, abs);
      const container = await this.#container(nodeId);
      const ops = bodyDiffOps(blocks, sections);
      if (ops.length > 0) {
        await writeContainer(this.#facet, container, ops, "notes");
      }
      const text = sections.map((s) => s.text).join(SECTION_SEP);
      await this.#project(nodeId, abs, text);
    });
  }

  async editSection(
    nodeId: string,
    sectionId: string,
    text: string,
  ): Promise<Section> {
    const abs = this.#resolve(nodeId);
    return this.#serialized(abs, async () => {
      const blocks = await this.#ingest(nodeId, abs);
      const hit = blocks.find((b) => b.slot === sectionId);
      if (hit === undefined) {
        throw new Error(
          `stale_section: section ${sectionId} is not part of node ${nodeId}.`,
        );
      }
      if ((hit.text ?? "") !== text) {
        const container = await this.#container(nodeId);
        await writeContainer(
          this.#facet,
          container,
          [
            {
              op: "update",
              slot: hit.slot,
              oldBlobId: hit.blobId ?? "",
              text,
            },
          ],
          "notes",
        );
      }
      const fresh = await this.#blocks(nodeId);
      await this.#project(nodeId, abs, this.#projectionOf(fresh));
      const now = fresh.find((b) => b.slot === sectionId);
      if (now === undefined) {
        throw new Error(
          `stale_section: node ${nodeId} has no body after the edit.`,
        );
      }
      return { id: now.slot, text: now.text ?? "", orderKey: now.position };
    });
  }

  async applySectionOps(
    nodeId: string,
    ops: SectionOp[],
  ): Promise<ApplySectionOpsResult> {
    const abs = this.#resolve(nodeId);
    return this.#serialized(abs, async () => {
      const blocks = await this.#ingest(nodeId, abs);
      const bySlot = new Map(blocks.map((b) => [b.slot, b]));
      const need = (sectionId: string): ContainerBlock => {
        const cur = bySlot.get(sectionId);
        if (cur === undefined) {
          throw new Error(
            `stale_section: section ${sectionId} is not part of node ${nodeId}.`,
          );
        }
        return cur;
      };
      const container = await this.#container(nodeId);
      const containerOps: ContainerOp[] = [];
      // section-op index → {container-op index (for adds), id, orderKey}.
      const plan: { addAt?: number; id: string; orderKey: string }[] = [];
      for (const op of ops) {
        switch (op.op) {
          case "add":
            plan.push({
              addAt: containerOps.length,
              id: "",
              orderKey: op.orderKey,
            });
            containerOps.push({
              op: "add",
              text: op.text,
              position: op.orderKey,
            });
            break;
          case "update": {
            const cur = need(op.sectionId);
            containerOps.push({
              op: "update",
              slot: cur.slot,
              oldBlobId: cur.blobId ?? "",
              text: op.text,
            });
            let key = cur.position;
            if (op.orderKey !== undefined && op.orderKey !== cur.position) {
              key = op.orderKey;
              containerOps.push({
                op: "reorder",
                slot: cur.slot,
                oldPosition: cur.position,
                position: key,
              });
            }
            plan.push({ id: cur.slot, orderKey: key });
            break;
          }
          case "delete": {
            const cur = need(op.sectionId);
            if (cur.blobId !== null) {
              containerOps.push({
                op: "remove",
                slot: cur.slot,
                position: cur.position,
                blobId: cur.blobId,
              });
            }
            plan.push({ id: cur.slot, orderKey: cur.position });
            break;
          }
          case "reorder": {
            const cur = need(op.sectionId);
            containerOps.push({
              op: "reorder",
              slot: cur.slot,
              oldPosition: cur.position,
              position: op.orderKey,
            });
            plan.push({ id: cur.slot, orderKey: op.orderKey });
            break;
          }
        }
      }
      let minted: Record<number, string> = {};
      if (containerOps.length > 0) {
        const res = await writeContainer(
          this.#facet,
          container,
          containerOps,
          "notes",
        );
        minted = res.minted;
      }
      const applied: AppliedOp[] = plan.map((p) => ({
        id: p.addAt !== undefined ? (minted[p.addAt] ?? p.id) : p.id,
        orderKey: p.orderKey,
      }));
      const fresh = await this.#blocks(nodeId);
      await this.#project(nodeId, abs, this.#projectionOf(fresh));
      return {
        sections: fresh.map((b) => ({
          id: b.slot,
          text: b.text ?? "",
          orderKey: b.position,
        })),
        applied,
      };
    });
  }

  async readRevisions(nodeId: string, limit = 50): Promise<RevisionMeta[]> {
    const abs = this.#resolve(nodeId);
    // Lazy capture first — an outside edit becomes a transaction the
    // moment history is asked for (the fs revlog's exact model).
    await this.#serialized(abs, () => this.#ingest(nodeId, abs));
    const container = await this.#container(nodeId);
    const entries = await containerHistory(this.#facet, container);
    return entries
      .slice()
      .reverse()
      .slice(0, limit)
      .map((e) => ({
        revision: String(e.tx),
        kind: "save",
        authoredBy: e.author === "" ? "human" : e.author,
        kafkaOffset: null,
        sections: 1,
      }));
  }

  async readRevisionAt(nodeId: string, revision: string): Promise<Section[]> {
    this.#resolve(nodeId); // path validation, same refusals as every verb
    const tx = Number.parseInt(revision, 10);
    if (!Number.isFinite(tx)) return [];
    const container = await this.#container(nodeId);
    const at = await readContainer(this.#facet, container, { asOfTx: tx });
    return at.blocks.map((b) => ({
      id: b.slot,
      text: b.text ?? "",
      orderKey: b.position,
    }));
  }

  async hasBody(nodeIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const nodeId of nodeIds) {
      try {
        const abs = this.#resolve(nodeId);
        const blocks = await this.#serialized(abs, () =>
          this.#ingest(nodeId, abs),
        );
        out.set(nodeId, blocks.length);
      } catch {
        out.set(nodeId, 0);
      }
    }
    return out;
  }

  // ── tags: the computed walk (extraction only — no sections derived) ────

  async listTags(): Promise<{ tags: TagCount[] }> {
    const index = await this.#tagIndex();
    return { tags: index.tags };
  }

  async listByTag(tag: string): Promise<{ tag: string; node_ids: string[] }> {
    const norm = normalizeTag(tag);
    const index = await this.#tagIndex();
    return { tag: norm, node_ids: index.byTag.get(norm) ?? [] };
  }

  async #tagIndex(): Promise<{
    tags: TagCount[];
    byTag: Map<string, string[]>;
  }> {
    const files: string[] = [];
    await walkTree(this.#root, this.#root, files);
    const byTag = new Map<string, string[]>();
    for (const abs of files.sort()) {
      let text: string;
      try {
        text = await fs.readFile(abs, "utf8");
      } catch {
        continue; // vanished mid-scan
      }
      const nodeId = path.relative(this.#root, abs).split(path.sep).join("/");
      for (const tag of extractInlineTags(text)) {
        byTag.set(tag, [...(byTag.get(tag) ?? []), nodeId]);
      }
    }
    const tags: TagCount[] = [...byTag.entries()]
      .map(([tag, ids]) => ({ tag, count: ids.length }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
    return { tags, byTag };
  }

  // ── search: the engine's own postgres (tsvector; semantic arm follows
  //    pgvector into the payload — dark until then, and NAMED dark) ───────

  async #ensureSearch(): Promise<Pool> {
    const pool = this.#pool;
    if (pool === null) throw new Error("search_dark");
    this.#searchReady ??= pool.query(SEARCH_SQL).then(() => undefined);
    await this.#searchReady;
    return pool;
  }

  async #index(nodeId: string, text: string): Promise<void> {
    if (this.#pool === null) return;
    try {
      const pool = await this.#ensureSearch();
      await pool.query(
        `INSERT INTO local_search (path, title, body) VALUES ($1, $2, $3)
         ON CONFLICT (path) DO UPDATE SET title = $2, body = $3`,
        [nodeId, titleOf(nodeId), text],
      );
      await pool.query(`DELETE FROM local_links WHERE path = $1`, [nodeId]);
      const targets = [...new Set(extractWikilinks(text))];
      if (targets.length > 0) {
        await pool.query(
          `INSERT INTO local_links (path, target)
           SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
          [nodeId, targets],
        );
      }
    } catch {
      // search darkness is not a write failure
    }
  }

  async #unindex(nodeId: string): Promise<void> {
    if (this.#pool === null) return;
    try {
      const pool = await this.#ensureSearch();
      await pool.query(`DELETE FROM local_search WHERE path = $1`, [nodeId]);
      await pool.query(`DELETE FROM local_links WHERE path = $1`, [nodeId]);
    } catch {
      // already dark
    }
  }

  async search(
    query: string,
    scope?: string,
    k?: number,
  ): Promise<SearchResponse> {
    const trimmed = query.trim();
    if (trimmed === "") throw new Error("bad_request: empty query.");
    const limit = k ?? DEFAULT_K;
    const armsQueried: SearchArm[] = [];
    const armsDark: SearchArm[] = ["semantic"]; // follows pgvector's payload
    let hits: SearchHit[] = [];
    if (this.#pool === null) {
      armsDark.unshift("fts");
      return { hits, armsQueried, armsDark };
    }
    try {
      const pool = await this.#ensureSearch();
      const res = await pool.query<{
        path: string;
        rank: number;
        snippet: string;
      }>(
        `SELECT path, ts_rank(tsv, q) AS rank,
                ts_headline('english', body, q,
                  'MaxWords=40, MinWords=10, MaxFragments=1') AS snippet
           FROM local_search, websearch_to_tsquery('english', $1) q
          WHERE tsv @@ q AND ($2::text IS NULL OR path LIKE $2 || '%')
          ORDER BY rank DESC LIMIT $3`,
        [trimmed, scope ?? null, Math.min(limit, ARM_DEPTH)],
      );
      armsQueried.push("fts");
      hits = res.rows.map((r) => ({
        id: r.path,
        snippet: clip(r.snippet),
        score: r.rank,
        arms: ["fts"],
      }));
    } catch {
      armsDark.unshift("fts");
    }
    return { hits, armsQueried, armsDark };
  }

  async mentions(nodeId: string): Promise<MentionsResponse> {
    const title = titleOf(nodeId);
    if (this.#pool === null) return { linked: [], unlinked: [] };
    try {
      const pool = await this.#ensureSearch();
      const linkedRes = await pool.query<{ path: string; body: string }>(
        `SELECT s.path, s.body FROM local_links l
           JOIN local_search s ON s.path = l.path
          WHERE l.target = $1 AND l.path <> $2 ORDER BY s.path`,
        [title.toLowerCase(), nodeId],
      );
      const linked: Mention[] = linkedRes.rows.map((r) => ({
        id: r.path,
        snippet: clip(r.body),
      }));
      const linkedPaths = new Set(linked.map((m) => m.id));
      const fts = await this.search(title, undefined, ARM_DEPTH);
      const unlinked = fts.hits
        .filter((h) => h.id !== nodeId && !linkedPaths.has(h.id))
        .map((h) => ({ id: h.id, snippet: h.snippet }));
      return { linked, unlinked };
    } catch {
      return { linked: [], unlinked: [] };
    }
  }
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
