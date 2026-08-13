/**
 * LocalSearchIndex (Findability F2) — the fs backend's search: an FTS5 arm
 * and a semantic arm over `<root>/.grace/search.sqlite`, fused with RRF into
 * the ruled envelope (docs/search-architecture.md). Freshness is the local
 * CQRS: a recursive fs watcher with per-path debounce and a coalescing work
 * queue; watcher construction failure degrades to a periodic sweep (the same
 * fallback Grace's shell uses for roots inotify cannot cross). Boot runs a
 * (mtime, size) catch-up diff. Sidecar-authored writes index immediately via
 * the FsBodyClient onWrite hook — no watcher round-trip.
 */

import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { chunk, isServedPath, normalizeBody, walkServed } from "./chunker.js";
import {
  DIMS,
  dotInt8,
  LOCAL_MODEL_ID,
  OrtEmbedder,
  resolveAssetsDir,
  type Embedder,
} from "./encoder.js";
import { rrfFuse, type ArmList, type SearchArm } from "./fusion.js";
import { RemoteEmbedder, remoteConfig } from "./remote-embed.js";
import { SearchStore } from "./store.js";

export interface SearchHit {
  id: string;
  snippet: string;
  score: number;
  arms: SearchArm[];
}

export interface SearchResponse {
  hits: SearchHit[];
  armsQueried: SearchArm[];
  armsDark: SearchArm[];
}

/** The seam server.ts consumes (any backend can implement it). */
export interface SearchProvider {
  search(query: string, scope?: string, k?: number): Promise<SearchResponse>;
}

export interface IndexOptions {
  /** Test seam: replaces the ORT encoder (null = no local encoder at all). */
  embedder?: Embedder | null;
  /** Test seam: debounce ms (default 250). */
  debounceMs?: number;
  /** Test seam: sweep interval ms when the watcher fails (default 30_000). */
  sweepMs?: number;
  /** Test seam: disable the fs watcher entirely. */
  watch?: boolean;
  /** Test seam: db path override (default `<root>/.grace/search.sqlite`). */
  dbPath?: string;
}

const EMBED_BATCH = 8;
const REMOTE_BATCH = 64;
const ARM_DEPTH = 128;
const DEFAULT_K = 20;

export class LocalSearchIndex implements SearchProvider {
  readonly #root: string;
  readonly #store: SearchStore;
  readonly #debounceMs: number;
  #embedder: Embedder | null = null;
  #embedderReady = false;
  #remote: RemoteEmbedder | null = null;
  #watcher: FSWatcher | null = null;
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #scanDone = false;
  #draining = false;
  #closed = false;
  #started: Promise<void> = Promise.resolve();
  /** The brute-force scan cache: parallel arrays over embedded blocks. */
  #cache: {
    version: number;
    paths: string[];
    texts: string[];
    matrix: Int8Array;
  } | null = null;

  private constructor(root: string, store: SearchStore, debounceMs: number) {
    this.#root = path.resolve(root);
    this.#store = store;
    this.#debounceMs = debounceMs;
  }

  /**
   * Open the index: constructs synchronously-usable state, then starts the
   * catch-up scan, the watcher (or sweep), and the encoder init in the
   * background — the sidecar's boot handshake never waits on any of it.
   */
  static open(root: string, opts: IndexOptions = {}): LocalSearchIndex {
    const dbPath =
      opts.dbPath ?? path.join(path.resolve(root), ".grace", "search.sqlite");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const index = new LocalSearchIndex(
      root,
      new SearchStore(dbPath),
      opts.debounceMs ?? 250,
    );
    index.#started = index.#start(opts);
    void index.#started.catch((err: unknown) => {
      console.error(
        `fs-search: startup failed (${err instanceof Error ? err.message : String(err)})`,
      );
    });
    return index;
  }

  /** Resolves when the boot sequence (encoder init + catch-up) finished. */
  get started(): Promise<void> {
    return this.#started;
  }

  /** Test/ops helper: resolves once the embed queue has fully drained. */
  async awaitIdle(): Promise<void> {
    await this.#started;
    for (;;) {
      if (this.#closed) return;
      const missing = await this.#storeMissing();
      if (missing === 0 && !this.#draining) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async #storeMissing(): Promise<number> {
    const local = this.#embedderReady ? this.#embedder : null;
    const remote =
      this.#remote !== null && !this.#remote.refused ? this.#remote : null;
    if (local === null && remote === null) return 0; // nothing can drain it
    return (await this.#store.missingVectors(1)).length;
  }

  async #start(opts: IndexOptions): Promise<void> {
    // Encoder: explicit seam wins; undefined = resolve the real assets.
    if (opts.embedder !== undefined) {
      this.#embedder = opts.embedder;
      this.#embedderReady = opts.embedder !== null;
    } else {
      try {
        const assets = await resolveAssetsDir();
        if (assets !== null) {
          this.#embedder = await OrtEmbedder.create(assets);
          this.#embedderReady = true;
        }
      } catch (err) {
        console.error(
          `fs-search: encoder unavailable (${err instanceof Error ? err.message : String(err)})` +
            " — semantic arm stays dark",
        );
      }
    }
    const remote = remoteConfig();
    if (remote !== null) {
      this.#remote = new RemoteEmbedder(
        remote,
        this.#embedder?.model ?? LOCAL_MODEL_ID,
      );
    }
    // A model change invalidates the foreign space before any embedding.
    if (this.#embedder !== null) {
      await this.#store.dropForeignVectors(this.#embedder.model);
    }
    await this.catchUp();
    if (opts.watch !== false) this.#startWatcher(opts.sweepMs ?? 30_000);
    void this.#drainQueue();
  }

  /** (mtime,size)-diff the root against the store; index what moved. */
  async catchUp(): Promise<void> {
    if (this.#closed) return;
    const onDisk = await walkServed(this.#root);
    const indexed = await this.#store.listFiles();
    const seen = new Set<string>();
    for (const f of onDisk) {
      seen.add(f.path);
      const known = indexed.get(f.path);
      if (known?.mtime !== f.mtime || known.size !== f.size) {
        await this.#indexFile(f.path);
      }
    }
    for (const [p] of indexed) {
      if (!seen.has(p)) await this.#store.removeFile(p);
    }
    this.#scanDone = true;
    void this.#drainQueue();
  }

  /** The FsBodyClient onWrite hook: index a just-written body immediately. */
  noteWritten(nodeId: string): void {
    if (!isServedPath(nodeId)) return;
    void this.#indexFile(nodeId).then(() => this.#drainQueue());
  }

  async #indexFile(relPath: string): Promise<void> {
    if (this.#closed) return;
    const abs = path.join(this.#root, relPath);
    let raw: Buffer;
    let stat;
    try {
      [raw, stat] = await Promise.all([fs.readFile(abs), fs.stat(abs)]);
    } catch {
      await this.#store.removeFile(relPath);
      return;
    }
    const paragraphs = chunk(normalizeBody(raw.toString("utf8")));
    await this.#store.upsertFile(
      relPath,
      Math.trunc(stat.mtimeMs),
      stat.size,
      paragraphs,
    );
  }

  #startWatcher(sweepMs: number): void {
    try {
      this.#watcher = watch(
        this.#root,
        { recursive: true },
        (_event, filename) => {
          if (filename === null) return;
          const rel = filename.split(path.sep).join("/");
          if (!isServedPath(rel)) return;
          this.#debounced(rel);
        },
      );
      this.#watcher.on("error", () => {
        this.#watcher?.close();
        this.#watcher = null;
        this.#startSweep(sweepMs);
      });
    } catch {
      // Roots the watcher cannot cross (UNC/9P) — the sweep substitutes.
      this.#startSweep(sweepMs);
    }
  }

  #startSweep(sweepMs: number): void {
    if (this.#sweepTimer !== null || this.#closed) return;
    this.#sweepTimer = setInterval(() => {
      void this.catchUp();
    }, sweepMs);
  }

  /** Per-path debounce: a bulk storm coalesces to one index pass per file. */
  #debounced(rel: string): void {
    const existing = this.#timers.get(rel);
    if (existing !== undefined) clearTimeout(existing);
    this.#timers.set(
      rel,
      setTimeout(() => {
        this.#timers.delete(rel);
        void this.#indexFile(rel).then(() => this.#drainQueue());
      }, this.#debounceMs),
    );
  }

  /** Background embed queue: remote accelerator for bulk when configured and
   *  not refused; the local encoder otherwise. Stops when neither can serve —
   *  and resumes on the next index event or catch-up. */
  async #drainQueue(): Promise<void> {
    if (this.#draining || this.#closed) return;
    this.#draining = true;
    try {
      for (;;) {
        const local = this.#embedderReady ? this.#embedder : null;
        const remote =
          this.#remote !== null && !this.#remote.refused ? this.#remote : null;
        if (local === null && remote === null) return;
        const batchSize = remote !== null ? REMOTE_BATCH : EMBED_BATCH;
        const missing = await this.#store.missingVectors(batchSize);
        if (missing.length === 0) return;
        const texts = missing.map((m) => m.text);
        let vectors: Int8Array[] | null = null;
        let model = "";
        if (remote !== null) {
          try {
            vectors = await remote.embed(texts);
            model = remote.model;
          } catch {
            vectors = null; // refused or down — fall through to local
          }
        }
        if (vectors === null && local !== null) {
          try {
            vectors = await local.embed(texts);
            model = local.model;
          } catch (err) {
            console.error(
              `fs-search: embed failed (${err instanceof Error ? err.message : String(err)})`,
            );
            return; // resumes on the next event
          }
        }
        if (vectors === null) return;
        for (let i = 0; i < missing.length; i++) {
          const m = missing[i];
          const v = vectors[i];
          if (m !== undefined && v !== undefined) {
            await this.#store.putVector(m.hash, v, model);
          }
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  async #vectorCache(scope?: string): Promise<{
    paths: string[];
    texts: string[];
    matrix: Int8Array;
  }> {
    // Scoped queries bypass the cache (rare path, still one SQL pass).
    if (scope !== undefined && scope !== "") {
      const rows = await this.#store.embeddedBlocks(scope);
      return materialize(rows);
    }
    if (this.#cache === null || this.#cache.version !== this.#store.version) {
      const version = this.#store.version;
      const rows = await this.#store.embeddedBlocks();
      this.#cache = { version, ...materialize(rows) };
    }
    return this.#cache;
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
    const armsDark: SearchArm[] = [];
    const lists: ArmList[] = [];

    // The FTS arm — answers whenever the index has content.
    if (this.#scanDone || (await this.#store.fileCount()) > 0) {
      armsQueried.push("fts");
      const ftsHits = await this.#store.ftsSearch(trimmed, scope, ARM_DEPTH);
      lists.push({
        arm: "fts",
        entries: ftsHits.map((h) => ({ id: h.path, snippet: h.snippet })),
      });
    } else {
      armsDark.push("fts");
    }

    // The semantic arm — local encoder + whatever vectors exist.
    const embedder = this.#embedderReady ? this.#embedder : null;
    if (embedder !== null) {
      try {
        const [queryVector] = await embedder.embed([trimmed]);
        const cache = await this.#vectorCache(scope);
        if (queryVector !== undefined && cache.paths.length > 0) {
          armsQueried.push("semantic");
          lists.push({
            arm: "semantic",
            entries: semanticScan(queryVector, cache, ARM_DEPTH),
          });
        } else {
          armsDark.push("semantic");
        }
      } catch {
        armsDark.push("semantic");
      }
    } else {
      armsDark.push("semantic");
    }

    return {
      hits: rrfFuse(lists, limit),
      armsQueried,
      armsDark,
    };
  }

  close(): void {
    this.#closed = true;
    this.#watcher?.close();
    if (this.#sweepTimer !== null) clearInterval(this.#sweepTimer);
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    this.#store.close();
  }
}

function materialize(
  rows: { path: string; text: string; vector: Int8Array }[],
): { paths: string[]; texts: string[]; matrix: Int8Array } {
  const matrix = new Int8Array(rows.length * DIMS);
  const paths = new Array<string>(rows.length);
  const texts = new Array<string>(rows.length);
  rows.forEach((r, i) => {
    matrix.set(r.vector, i * DIMS);
    paths[i] = r.path;
    texts[i] = r.text;
  });
  return { paths, texts, matrix };
}

/** The semantic relevance floor: vectors are unit ×127, so a raw dot of
 *  cos·127² — pairs under cos ≈ 0.25 are noise for MiniLM-class encoders,
 *  and ranking them would make every query "match" every note. */
const SEMANTIC_FLOOR = Math.round(0.25 * 127 * 127);

/** Brute-force int8 dot scan — the ruled no-ANN search. Best block per path. */
function semanticScan(
  queryVector: Int8Array,
  cache: { paths: string[]; texts: string[]; matrix: Int8Array },
  depth: number,
): { id: string; snippet?: string }[] {
  const n = cache.paths.length;
  const scored: { i: number; score: number }[] = [];
  for (let i = 0; i < n; i++) {
    const score = dotInt8(
      queryVector,
      cache.matrix.subarray(i * DIMS, (i + 1) * DIMS),
    );
    if (score >= SEMANTIC_FLOOR) scored.push({ i, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: { id: string; snippet?: string }[] = [];
  for (const { i } of scored) {
    const p = cache.paths[i];
    if (p === undefined || seen.has(p)) continue;
    seen.add(p);
    const text = cache.texts[i] ?? "";
    out.push({
      id: p,
      snippet: text.length > 200 ? `${text.slice(0, 200)}…` : text,
    });
    if (out.length >= depth) break;
  }
  return out;
}
