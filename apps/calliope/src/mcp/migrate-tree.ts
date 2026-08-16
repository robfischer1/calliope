#!/usr/bin/env bun
/**
 * F6 migration tool (spec 043, Git for Ideas) — move every old-store
 * container into the blob+tree model: prose → blobs, membership/order →
 * tree facts, history → a chain of graph transactions.
 *
 * Replay, per container, oldest revision first: the diff between
 * consecutive reconstructions is keyed on section ids PLUS the
 * supersessions edges, so a slot's identity is CONTINUOUS across the old
 * model's re-minted ids — the exact churn this migration retires. One
 * admit per non-empty revision, blob-first inside it. Parity is per-row
 * and two-sided (HEAD + every revision as-of its recorded tx); any
 * mismatch exits nonzero naming the rows. Markers make re-runs no-ops and
 * interrupted runs resumable; old-store drift AFTER a marker refuses.
 *
 * The OLD tables are never written — reads stay on them until F12 cuts,
 * gated on this run's parity report.
 *
 * Modes (env: DATABASE_URL, CALLIOPE_CHAOS_URL, CALLIOPE_THEMIS_URL):
 *
 *   bun run src/mcp/migrate-tree.ts            # migrate + parity
 *   bun run src/mcp/migrate-tree.ts --probe    # read-only counts
 *   bun run src/mcp/migrate-tree.ts --limit 10 # first N containers
 *   bun run src/mcp/migrate-tree.ts --node <id># one container
 */

import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { BlobStore, type ProseStore } from "../blob-store.js";
import {
  type AdmitResult,
  type ChaosDial,
  type ChaosOp,
  type HistoryEntry,
  LiveChaosDial,
  type NodeEdge,
  opAdd,
  opCreate,
  opRemove,
  type QuadRow,
  type Tenant,
  tenantScope,
} from "../chaos-client.js";
import { readContainer } from "../container-read.js";
import { PgBodyClient } from "../pg-client.js";
import {
  repointOps,
  repositionOps,
  slotBirthOps,
  slotRemoveOps,
  TREE_MEMBER,
  TREE_POSITION,
} from "../tree.js";
import { COMMENT_CONTAINER_SUFFIX } from "../types.js";
import type { Section } from "../types.js";

/** Provenance vocabulary (slots keep their old ids; audits and comments
 *  resolve through these after the old tables drop). */
export const MIGRATED_FROM_SECTION = "migrated_from_section";
export const MIGRATED_CONTAINER_ID = "migrated_container_id";
export const SECTIONS_MIGRATED = "sections_migrated";
/** Per-revision original authorship, kept IN THE GRAPH (Rob, 2026-08-16):
 *  the admit wire deliberately carries no author override (N5), so each
 *  replayed revision's original author + timestamp land as one scalar
 *  fact on the container — queryable after F12 drops the old tables,
 *  without opening an identity-assertion door on the gate. */
export const MIGRATION_PROVENANCE = "migration_provenance";
export const COMMENTS_ON = "comments_on";

const HEX64 = /^[0-9a-f]{64}$/;

export interface MigrateTreeDeps {
  pg: PgBodyClient;
  pool: Pool;
  blobs: ProseStore;
  dial: ChaosDial;
}

export interface RevisionRecord {
  revision: string;
  authoredBy: string;
  tx: number | null;
  ops: number;
}

export interface ContainerRecord {
  node: string;
  container: string;
  tenant: Tenant;
  status: "migrated" | "skipped" | "refused_drift" | "parity_failed";
  revisions: RevisionRecord[];
}

export interface MigrateTreeReport {
  probe: boolean;
  containers: number;
  migrated: number;
  skipped: number;
  refused: string[];
  parity_mismatches: string[];
  comments_migrated: number;
  comments_unresolved: string[];
  per_container: ContainerRecord[];
}

interface SlotState {
  slot: string;
  position: string;
  blobId: string;
  text: string;
}

/** Transient-failure patterns that are SAFE to retry even for admit: each
 *  means the connection was never established (DNS lookup, dial, refusal),
 *  so no transaction can have landed. Anything mid-flight stays fatal for
 *  writes — an admit whose RESPONSE was lost may have landed, and a blind
 *  replay would double-apply the batch. (The full-run casualty, 2026-08-16:
 *  docker's embedded DNS answered "server misbehaving" once, ~25 minutes
 *  in, and the fail-fast runner died with 6,000 containers to go.) */
const ADMIT_RETRYABLE =
  /dial tcp|server misbehaving|no such host|connection refused|ECONNREFUSED|EAI_AGAIN/i;

const RETRY_TRIES = 6;

async function withRetry<T>(
  fn: () => Promise<T>,
  safe: (err: unknown) => boolean,
  label: string,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRY_TRIES || !safe(err)) throw err;
      const delay = Math.min(2 ** attempt * 1000, 30_000);
      console.error(
        `migrate-tree: transient ${label} failure (attempt ` +
          `${String(attempt)}), retrying in ${String(delay)}ms: ${String(err)}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** A dial that survives infrastructure blips on an hour-long run. Reads
 *  are idempotent — any failure retries. admit retries ONLY on errors
 *  proving the request never reached the store (ADMIT_RETRYABLE). */
export class RetryingDial implements ChaosDial {
  readonly #inner: ChaosDial;
  constructor(inner: ChaosDial) {
    this.#inner = inner;
  }
  admit(ops: ChaosOp[], scope: string): Promise<AdmitResult> {
    return withRetry(
      () => this.#inner.admit(ops, scope),
      (err) => ADMIT_RETRYABLE.test(String(err)),
      "admit",
    );
  }
  findByName(kind: string, label: string): Promise<string[]> {
    return withRetry(
      () => this.#inner.findByName(kind, label),
      () => true,
      "read",
    );
  }
  resolveNodes(tokens: string[]): Promise<Record<string, string>> {
    return withRetry(
      () => this.#inner.resolveNodes(tokens),
      () => true,
      "read",
    );
  }
  edges(token: string): Promise<NodeEdge[]> {
    return withRetry(
      () => this.#inner.edges(token),
      () => true,
      "read",
    );
  }
  findByValue(
    scope: string,
    predicate: string,
    value: string,
  ): Promise<string[]> {
    return withRetry(
      () => this.#inner.findByValue(scope, predicate, value),
      () => true,
      "read",
    );
  }
  registerGraph(name: string): Promise<void> {
    return withRetry(
      () => this.#inner.registerGraph(name),
      () => true,
      "read",
    );
  }
  quadsFrom(
    subjects: string[],
    asOfTx: number | null,
    predicateNames: string[] | null,
    graph?: string,
  ): Promise<QuadRow[]> {
    return withRetry(
      () => this.#inner.quadsFrom(subjects, asOfTx, predicateNames, graph),
      () => true,
      "read",
    );
  }
  resolveScalars(hashes: string[]): Promise<Record<string, string>> {
    return withRetry(
      () => this.#inner.resolveScalars(hashes),
      () => true,
      "read",
    );
  }
  history(
    subjects: string[],
    follow: string[],
    graph?: string,
  ): Promise<HistoryEntry[]> {
    return withRetry(
      () => this.#inner.history(subjects, follow, graph),
      () => true,
      "read",
    );
  }
  heldBlobs(graph?: string): Promise<string[]> {
    return withRetry(
      () => this.#inner.heldBlobs(graph),
      () => true,
      "read",
    );
  }
}

/** The old store's per-container revision list, oldest first. */
async function revisionsAsc(
  pg: PgBodyClient,
  node: string,
): Promise<{ revision: string; authoredBy: string }[]> {
  const revs = await pg.readRevisions(node, 1_000_000);
  return revs
    .map((r) => ({ revision: r.revision, authoredBy: r.authoredBy }))
    .reverse();
}

/** successor id → predecessor ids (insertion order), for one node. */
async function supersessionEdges(
  pool: Pool,
  node: string,
): Promise<Map<string, string[]>> {
  const res = await pool.query<{
    successor_id: string;
    predecessor_id: string;
  }>(
    `SELECT successor_id, predecessor_id FROM supersessions
      WHERE node_id = $1 ORDER BY created_at, successor_id, predecessor_id`,
    [node],
  );
  const out = new Map<string, string[]>();
  for (const row of res.rows) {
    const list = out.get(row.successor_id) ?? [];
    list.push(row.predecessor_id);
    out.set(row.successor_id, list);
  }
  return out;
}

function tenantOf(node: string): Tenant {
  return node.endsWith(COMMENT_CONTAINER_SUFFIX) ? "comments" : "notes";
}

/** Read the container's marker + slot map from the graph (resume state). */
async function graphState(
  dial: ChaosDial,
  container: string,
): Promise<{ marker: string | null }> {
  const edges = await dial.edges(container);
  const marker = edges.find(
    (e) => e.predicate === SECTIONS_MIGRATED && e.domain === "scalar",
  );
  return { marker: marker?.value ?? null };
}

/** Resolve (or mint) the graph node for an old container id. */
async function resolveContainer(
  dial: ChaosDial,
  node: string,
  tenant: Tenant,
  probe: boolean,
): Promise<string | null> {
  if (HEX64.test(node)) return node;
  return acquireCarrier(dial, node, tenant, probe);
}

/** The carrier path — a kind-"node" stand-in labelled by the old id, the
 *  provenance fact as its index; idempotent via findByName. Serves (a)
 *  non-hex container ids and (b) hex containers whose graph node has NO
 *  nodes row (full-run finding, 2026-08-16: 415 old sections containers
 *  outlive their nodes — most are TOMBSTONED and still satisfy the facts
 *  FK, but hard-absent ones refuse at the subject guard, so their replay
 *  lands on a carrier instead). */
async function acquireCarrier(
  dial: ChaosDial,
  node: string,
  tenant: Tenant,
  probe: boolean,
): Promise<string | null> {
  const existing = await dial.findByName("node", node);
  const first = existing[0];
  if (first !== undefined) return first;
  if (probe) return null;
  const res = await dial.admit(
    [
      opCreate("node", node),
      opAdd(node, MIGRATED_CONTAINER_ID, { toLiteral: node }),
    ],
    tenantScope(tenant),
  );
  return res.minted[0] ?? null;
}

/** True iff the thrown admit error is chaos's subject guard refusing OUR
 *  container for having no nodes row — the one refusal the carrier path
 *  answers. Guard-driven on purpose: the guard IS the existence oracle
 *  (resolveNodes filters tombstones and would over-report absence). */
function isMissingSubject(err: unknown, node: string): boolean {
  const text = String(err);
  return text.includes("no nodes row") && text.includes(`s=${node}`);
}

/** Diff one revision step into tree ops. Mutates `slots` to the new state
 *  once the admit lands (the caller applies `next` after success). */
function diffRevision(
  container: string,
  slots: Map<string, SlotState>,
  target: Section[],
  supersedes: Map<string, string[]>,
  mintBlob: (text: string) => Promise<string>,
): {
  build: () => Promise<{
    batch: ChaosOp[];
    births: { sectionId: string; label: string }[];
    next: (minted: string[]) => Map<string, SlotState>;
  }>;
} {
  return {
    async build() {
      const batch: ChaosOp[] = [];
      const births: { sectionId: string; label: string }[] = [];
      const consumed = new Set<string>();
      const nextState = new Map<string, SlotState>();
      const targetIds = new Set(target.map((s) => s.id));

      for (const section of target) {
        const existing = slots.get(section.id);
        if (existing !== undefined) {
          // Same old id survives — text is immutable in place in the old
          // model; position may drift on reorder-adjacent events.
          consumed.add(section.id);
          let state = existing;
          if (existing.text !== section.text) {
            const blobId = await mintBlob(section.text);
            if (blobId !== existing.blobId) {
              batch.push(...repointOps(existing.slot, existing.blobId, blobId));
              state = { ...state, blobId, text: section.text };
            }
          }
          if (existing.position !== section.orderKey) {
            batch.push(
              ...repositionOps(existing.slot, state.position, section.orderKey),
            );
            state = { ...state, position: section.orderKey };
          }
          nextState.set(section.id, state);
          continue;
        }
        // A successor: its FIRST predecessor's slot continues; any other
        // predecessors' slots are removed below (merge semantics).
        const preds = (supersedes.get(section.id) ?? []).filter((p) =>
          slots.has(p),
        );
        const carrier = preds[0];
        if (carrier !== undefined) {
          const prev = slots.get(carrier);
          if (prev === undefined) throw new Error("carrier vanished");
          consumed.add(carrier);
          // The successor's id ALSO maps to this slot: a comment (or any
          // cross-reference) may cite any generation's id, and after F12
          // the provenance facts are the only index left.
          batch.push(
            opAdd(prev.slot, MIGRATED_FROM_SECTION, {
              toLiteral: section.id,
            }),
          );
          let state: SlotState = { ...prev };
          if (prev.text !== section.text) {
            const blobId = await mintBlob(section.text);
            if (blobId !== prev.blobId) {
              batch.push(...repointOps(prev.slot, prev.blobId, blobId));
              state = { ...state, blobId, text: section.text };
            }
          }
          if (prev.position !== section.orderKey) {
            batch.push(
              ...repositionOps(prev.slot, state.position, section.orderKey),
            );
            state = { ...state, position: section.orderKey };
          }
          nextState.set(section.id, state);
          continue;
        }
        // Genuinely new.
        const blobId = await mintBlob(section.text);
        const label = `m:${section.id}`;
        batch.push(
          ...slotBirthOps(container, label, section.orderKey, blobId),
          opAdd(label, MIGRATED_FROM_SECTION, { toLiteral: section.id }),
        );
        births.push({ sectionId: section.id, label });
        nextState.set(section.id, {
          slot: label, // resolved to the minted token in next()
          position: section.orderKey,
          blobId,
          text: section.text,
        });
      }

      // Departures: previous ids neither present nor consumed as carriers.
      for (const [id, state] of slots) {
        if (targetIds.has(id) || consumed.has(id)) continue;
        batch.push(
          ...slotRemoveOps(state.slot, container, state.position, state.blobId),
        );
      }

      const next = (minted: string[]): Map<string, SlotState> => {
        let mintIndex = 0;
        for (const { sectionId } of births) {
          const token = minted[mintIndex];
          mintIndex += 1;
          const state = nextState.get(sectionId);
          if (token !== undefined && state !== undefined) {
            nextState.set(sectionId, { ...state, slot: token });
          }
        }
        return nextState;
      };
      return { batch, births, next };
    },
  };
}

/**
 * Old-model debris: two sections can share an order_key (the old read
 * tiebreaks on id; the tree's address cannot). Canonicalize a revision's
 * positions to be UNIQUE while preserving the old read's exact order —
 * readRevisionAt already answers (order_key COLLATE "C", id) sorted, so a
 * duplicate run keeps its order and the i-th member takes orderKey +
 * "0"×i ("a" < "a0" < "a00" bytewise). Deterministic across re-runs.
 */
function canonicalizePositions(target: Section[]): Section[] {
  const out: Section[] = [];
  let run = "";
  let runLength = 0;
  for (const section of target) {
    if (section.orderKey === run) {
      runLength += 1;
      out.push({
        ...section,
        orderKey: section.orderKey + "0".repeat(runLength),
      });
    } else {
      run = section.orderKey;
      runLength = 0;
      out.push(section);
    }
  }
  return out;
}

/** Compare two block lists on (text, order) — the parity canon. */
function sameProse(
  a: { text: string | null }[],
  b: { text: string }[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.text !== b[i]?.text) return false;
  }
  return true;
}

export async function migrateTree(
  deps: MigrateTreeDeps,
  opts: { probe?: boolean; limit?: number; node?: string } = {},
): Promise<MigrateTreeReport> {
  const { pg, pool, blobs, dial } = deps;
  const probe = opts.probe === true;
  const report: MigrateTreeReport = {
    probe,
    containers: 0,
    migrated: 0,
    skipped: 0,
    refused: [],
    parity_mismatches: [],
    comments_migrated: 0,
    comments_unresolved: [],
    per_container: [],
  };

  // The tenant graphs must exist before any admit lands facts in them —
  // live chaos refuses writes to an unregistered graph (the graph guard),
  // and "comments" predates nothing: this run is its first writer. The
  // fixture's registerGraph is a no-op set, which is exactly why this
  // line exists here and not in a test's beforeAll.
  if (!probe) {
    await dial.registerGraph(tenantScope("notes"));
    await dial.registerGraph(tenantScope("comments"));
  }

  const nodesRes = await pool.query<{ node_id: string }>(
    `SELECT DISTINCT node_id FROM sections ORDER BY node_id`,
  );
  let nodes = nodesRes.rows.map((r) => r.node_id);
  if (opts.node !== undefined) nodes = nodes.filter((n) => n === opts.node);
  if (opts.limit !== undefined) nodes = nodes.slice(0, opts.limit);
  report.containers = nodes.length;

  // Section id → slot token, across containers (comments resolution).
  const slotBySection = new Map<string, { slot: string; tenant: Tenant }>();

  containers: for (const node of nodes) {
    const tenant = tenantOf(node);
    const scope = tenantScope(tenant);
    const revs = await revisionsAsc(pg, node);
    const markerValue = `${String(revs.length)}@${revs[revs.length - 1]?.revision ?? "empty"}`;
    const record: ContainerRecord = {
      node,
      container: "",
      tenant,
      status: "migrated",
      revisions: [],
    };
    report.per_container.push(record);

    let container = await resolveContainer(dial, node, tenant, probe);
    if (container === null) {
      if (!probe) report.refused.push(`${node}: container unresolvable`);
      continue;
    }
    record.container = container;

    // A hex container whose node has no nodes row cannot carry facts; the
    // replay retries ONCE on a carrier when the subject guard says so —
    // guard-driven, so there is no second existence oracle to drift.
    let carrierTried = false;
    replay: for (;;) {
      try {
        const { marker } = await graphState(dial, container);
        if (marker !== null) {
          if (marker === markerValue) {
            record.status = "skipped";
            report.skipped += 1;
            continue containers; // comments resolution falls back to findByValue
          }
          record.status = "refused_drift";
          report.refused.push(
            `${node}: old store changed after migration (marker ${marker} != ${markerValue}) — the old store must be frozen`,
          );
          continue containers;
        }
        if (probe) continue containers;

        // Crash recovery — a prior run that died mid-replay left tree facts
        // with no marker (the marker is stamped only after parity passes).
        // Replaying onto that debris would re-birth every slot and fail HEAD
        // parity with doubled prose, so the debris is removed first and the
        // replay starts from a clean tree. tx stays null: cleanup is
        // bookkeeping, not a revision — parity and provenance both skip it.
        const dirty = await readContainer({ blobs, dial }, container);
        if (dirty.blocks.length > 0) {
          const cleanup: ChaosOp[] = [];
          for (const b of dirty.blocks) {
            if (b.blobId !== null) {
              cleanup.push(
                ...slotRemoveOps(b.slot, container, b.position, b.blobId),
              );
            } else {
              cleanup.push(
                opRemove(container, TREE_MEMBER, { toNode: b.slot }),
                opRemove(b.slot, TREE_POSITION, { toLiteral: b.position }),
              );
            }
          }
          const res = await dial.admit(cleanup, scope);
          if (!res.admitted) {
            record.status = "parity_failed";
            report.refused.push(
              `${node}: partial-state cleanup refused: ${JSON.stringify(res.violations)}`,
            );
            continue containers;
          }
          record.revisions.push({
            revision: "partial-cleanup",
            authoredBy: "migrate-tree",
            tx: null,
            ops: cleanup.length,
          });
        }

        const supersedes = await supersessionEdges(pool, node);
        let slots = new Map<string, SlotState>();
        let lastTx: number | null = null;
        for (const rev of revs) {
          const target = canonicalizePositions(
            await pg.readRevisionAt(node, rev.revision),
          );
          const { build } = diffRevision(
            container,
            slots,
            target,
            supersedes,
            (text) => blobs.mint(text),
          );
          const { batch, next } = await build();
          if (batch.length === 0) {
            record.revisions.push({
              revision: rev.revision,
              authoredBy: rev.authoredBy,
              tx: lastTx,
              ops: 0,
            });
            slots = next([]);
            continue;
          }
          const res = await dial.admit(batch, scope);
          if (!res.admitted) {
            record.status = "parity_failed";
            report.refused.push(
              `${node}@${rev.revision}: admit refused: ${JSON.stringify(res.violations)}`,
            );
            break;
          }
          lastTx = res.tx ?? null;
          record.revisions.push({
            revision: rev.revision,
            authoredBy: rev.authoredBy,
            tx: lastTx,
            ops: batch.length,
          });
          slots = next(res.minted);
        }
        if (record.status !== "migrated") continue containers;

        // HEAD reconcile — import-shaped debris, found live (container
        // 00fad279…): a bulk import lands N ACTIVE anchor rows (supersedes
        // NULL, distinct created_at), so the old model's HEAD reads all of
        // them while its history reads each as a one-row generation. The
        // replay honestly reproduces the history; this closing pass diffs the
        // replayed end-state onto the old HEAD read so the tree's head equals
        // readBody exactly — one more transaction, recorded as its own
        // synthetic revision.
        const headTarget = canonicalizePositions(await pg.readBody(node));
        const headDiff = await diffRevision(
          container,
          slots,
          headTarget,
          supersedes,
          (text) => blobs.mint(text),
        ).build();
        if (headDiff.batch.length > 0) {
          const res = await dial.admit(headDiff.batch, scope);
          if (!res.admitted) {
            record.status = "parity_failed";
            report.refused.push(
              `${node}@head-reconcile: admit refused: ${JSON.stringify(res.violations)}`,
            );
            continue containers;
          }
          lastTx = res.tx ?? null;
          record.revisions.push({
            revision: "head-reconcile",
            authoredBy: "migrate-tree",
            tx: lastTx,
            ops: headDiff.batch.length,
          });
          slots = headDiff.next(res.minted);
        }

        for (const [sectionId, state] of slots) {
          slotBySection.set(sectionId, { slot: state.slot, tenant });
        }

        // Parity, two-sided. HEAD:
        const facet = { blobs, dial };
        const oldHead = await pg.readBody(node);
        const newHead = await readContainer(facet, container);
        if (!sameProse(newHead.blocks, oldHead)) {
          record.status = "parity_failed";
          report.parity_mismatches.push(`${node}: HEAD texts/order diverge`);
          continue containers;
        }
        // Every revision as-of its tx:
        let parityOk = true;
        for (const rev of record.revisions) {
          if (rev.tx === null) continue; // pre-first-content revisions
          if (rev.revision === "head-reconcile") continue; // synthetic — HEAD covers it
          const oldAt = await pg.readRevisionAt(node, rev.revision);
          const newAt = await readContainer(facet, container, {
            asOfTx: rev.tx,
          });
          if (!sameProse(newAt.blocks, oldAt)) {
            record.status = "parity_failed";
            report.parity_mismatches.push(
              `${node}@${rev.revision} (tx ${String(rev.tx)}): as-of texts/order diverge`,
            );
            parityOk = false;
          }
        }
        if (!parityOk) continue containers;

        // Mark converged — ONE bookkeeping admit carrying the marker AND the
        // per-revision original-authorship facts (never rides a revision
        // batch, so as-of parity reads are untouched; history honestly shows
        // one migration-bookkeeping transaction per container).
        const bookkeeping: ChaosOp[] = [
          opAdd(container, SECTIONS_MIGRATED, { toLiteral: markerValue }),
        ];
        for (const rev of record.revisions) {
          if (rev.tx === null) continue;
          bookkeeping.push(
            opAdd(container, MIGRATION_PROVENANCE, {
              toLiteral: `tx=${String(rev.tx)} at=${rev.revision} by=${rev.authoredBy}`,
            }),
          );
        }
        await dial.admit(bookkeeping, scope);
        report.migrated += 1;
        break replay;
      } catch (err) {
        // The subject guard's "no nodes row" for OUR hex container: land
        // the whole replay on a carrier instead and start over. Any other
        // error stays fatal (fail-fast is this tool's contract).
        if (
          !carrierTried &&
          container === node &&
          isMissingSubject(err, node)
        ) {
          carrierTried = true;
          const carrier = await acquireCarrier(dial, node, tenant, false);
          if (carrier === null) {
            record.status = "parity_failed";
            report.refused.push(`${node}: carrier mint failed`);
            continue containers;
          }
          container = carrier;
          record.container = container;
          record.revisions = [];
          record.status = "migrated";
          continue replay;
        }
        throw err;
      }
    }
  }

  // comments_on → slot-to-slot facts in the comments graph.
  if (!probe) {
    const commentRows = await pool.query<{
      comment_id: string;
      target_id: string;
      node_id: string;
    }>(`SELECT comment_id, target_id, node_id FROM comments_on
         ORDER BY node_id, comment_id`);
    for (const row of commentRows.rows) {
      const comment =
        slotBySection.get(row.comment_id) ??
        (await findSlot(dial, row.comment_id, "comments"));
      const target =
        slotBySection.get(row.target_id) ??
        (await findSlot(dial, row.target_id, "notes"));
      if (comment === null || target === null) {
        report.comments_unresolved.push(
          `${row.comment_id} -> ${row.target_id} (${row.node_id})`,
        );
        continue;
      }
      const existing = await dial.edges(comment.slot);
      const already = existing.some(
        (e) =>
          e.predicate === COMMENTS_ON &&
          e.domain === "node" &&
          e.value === target.slot,
      );
      if (!already) {
        await dial.admit(
          [opAdd(comment.slot, COMMENTS_ON, { toNode: target.slot })],
          tenantScope("comments"),
        );
      }
      report.comments_migrated += 1;
    }
  }
  return report;
}

/** Cross-run slot resolution: the provenance fact is the index. */
async function findSlot(
  dial: ChaosDial,
  sectionId: string,
  tenant: Tenant,
): Promise<{ slot: string; tenant: Tenant } | null> {
  const hits = await dial.findByValue(
    tenantScope(tenant),
    MIGRATED_FROM_SECTION,
    sectionId,
  );
  const slot = hits[0];
  return slot === undefined ? null : { slot, tenant };
}

async function main(): Promise<void> {
  const probe = process.argv.includes("--probe");
  const limitIdx = process.argv.indexOf("--limit");
  const nodeIdx = process.argv.indexOf("--node");
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") {
    console.error("migrate-tree: DATABASE_URL is required");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });
  const deps: MigrateTreeDeps = {
    pg: new PgBodyClient(pool),
    pool,
    blobs: new BlobStore(pool),
    dial: new RetryingDial(new LiveChaosDial()),
  };
  const opts: { probe?: boolean; limit?: number; node?: string } = {};
  if (probe) opts.probe = true;
  if (limitIdx !== -1) opts.limit = Number(process.argv[limitIdx + 1]);
  if (nodeIdx !== -1) {
    const nodeArg = process.argv[nodeIdx + 1];
    if (nodeArg !== undefined) opts.node = nodeArg;
  }
  const report = await migrateTree(deps, opts);
  console.log(JSON.stringify(report, null, 2));
  await pool.end();
  const failed =
    report.refused.length > 0 || report.parity_mismatches.length > 0;
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
