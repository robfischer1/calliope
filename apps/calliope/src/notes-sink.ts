/**
 * The note-native dissolve sink (F6 — the store consolidation).
 *
 * A dissolved document stops being a row in a second store and becomes a
 * NOTE: a graph identity (named by its `source_path` — the unique, stable
 * vault identity; human titles collide) carrying its provenance as
 * ATTRIBUTES, whose body is a one-block container in the sovereign store.
 * Version history becomes copy-on-write generations — the insert-only →
 * CoW reconciliation the master-plan surfaced.
 *
 * Provenance attribute contract (what B6's notes-indexing reads):
 * `source_path` · `raw_hash` (newest) · `source_kind` · `mtime` · `ctime` ·
 * `title` · `schema_type` · `file_path` · `dissolved_at` — literal edges on
 * the note, absent when the source column is NULL. Never a second table.
 *
 * Everything here is idempotent: the mint is reuse-first (createNote's
 * (Note, name) key), the body save no-ops on an identical active body
 * (container-grain dedup, the F4 no-op's coarse sibling), and the attribute
 * reconcile diffs current edges before writing (changed values retract the
 * old literal). A retried or re-run dissolve converges instead of inflating
 * history.
 */

import type { BodyClient } from "./types.js";
import type { WriteDocumentInput } from "./document-store.js";
import { sha256 } from "./document-store.js";
import {
  type ChaosDial,
  ChaosClientError,
  opAdd,
  opRemove,
  type ChaosOp,
} from "./chaos-client.js";
import type { TagStore } from "./tag-store.js";
import {
  createNote,
  isCreateNoteError,
  maybeReconcileInlineTags,
} from "./mcp/tools.js";

/** The sink's answer: the note + what this call did to its body. */
export interface SinkResult {
  node_id: string;
  /** Did this call mint the note's graph identity? */
  created: boolean;
  /** What the body write did: minted the first generation, superseded the
   *  active one, or no-oped on an identical body. */
  generation: "minted" | "superseded" | "nooped";
}

/** A structured sink failure (admit refusals surface verbatim). */
export class NotesSinkError extends Error {
  constructor(
    message: string,
    readonly violations: unknown[] = [],
  ) {
    super(message);
    this.name = "NotesSinkError";
  }
}

/** The provenance attributes as (predicate, value) pairs — absent = unset. */
function provenanceAttrs(
  input: WriteDocumentInput,
  dissolvedAt?: string,
): Map<string, string> {
  const attrs = new Map<string, string>();
  attrs.set("source_path", input.source_path);
  attrs.set("raw_hash", input.raw_hash ?? sha256(input.body_text));
  attrs.set("source_kind", input.source_kind ?? "vault-note");
  if (input.mtime !== undefined) {
    attrs.set("mtime", input.mtime);
  }
  if (input.ctime !== undefined) {
    attrs.set("ctime", input.ctime);
  }
  if (input.subject !== undefined) {
    attrs.set("title", input.subject);
  }
  attrs.set("schema_type", input.schema_type ?? "DigitalDocument");
  if (input.file_path !== undefined) {
    attrs.set("file_path", input.file_path);
  }
  if (dissolvedAt !== undefined) {
    attrs.set("dissolved_at", dissolvedAt);
  }
  return attrs;
}

/**
 * Reconcile the note's provenance attribute edges to `next`: assert missing
 * values, retract superseded ones. One admit batch; zero ops = zero calls.
 */
async function reconcileAttrs(
  dial: ChaosDial,
  scope: string,
  nodeId: string,
  next: Map<string, string>,
): Promise<void> {
  const current = await dial.edges(nodeId);
  const ops: ChaosOp[] = [];
  for (const [predicate, value] of next) {
    const standing = current.filter((e) => e.predicate === predicate);
    if (standing.some((e) => !e.isNode && e.value === value)) {
      continue; // already exact
    }
    for (const stale of standing) {
      if (!stale.isNode) {
        ops.push(opRemove(nodeId, predicate, { toLiteral: stale.value }));
      }
    }
    ops.push(opAdd(nodeId, predicate, { toLiteral: value }));
  }
  if (ops.length === 0) {
    return;
  }
  const res = await dial.admit(ops, scope);
  if (!res.admitted) {
    throw new NotesSinkError(
      `notes-sink: the gate refused the provenance batch for ${nodeId}`,
      res.violations,
    );
  }
}

/**
 * The shared sink core: mint/reuse the note (identity = `source_path`),
 * land `blocks` as one generation unless the active body is elementwise
 * identical, reconcile the provenance attributes, materialise inline tags.
 * Both dissolve grains (one-block document version, multi-block container)
 * ride this ONE path — no second sink to drift.
 */
async function landContainer(
  client: BodyClient,
  dial: ChaosDial,
  scope: string,
  tagStore: TagStore | undefined,
  sourcePath: string,
  blocks: readonly string[],
  attrs: Map<string, string>,
): Promise<SinkResult> {
  const minted = await createNote(
    dial,
    scope,
    { title: sourcePath },
    undefined, // tags ride the inline reconcile below, not the mint
  );
  if (isCreateNoteError(minted)) {
    throw new NotesSinkError(
      `notes-sink: ${minted.error}: ${minted.detail}`,
      minted.violations ?? [],
    );
  }

  // Container-grain dedup: an elementwise-identical active body writes
  // nothing — a retried or re-run dissolve converges.
  const active = await client.readBody(minted.node_id);
  const same =
    active.length === blocks.length &&
    active.every((s, i) => s.text === blocks[i]);
  let generation: SinkResult["generation"];
  if (same && active.length > 0) {
    generation = "nooped";
  } else {
    await client.saveBody(
      minted.node_id,
      blocks.map((text) => ({ text })),
    );
    generation = active.length === 0 ? "minted" : "superseded";
  }

  await reconcileAttrs(dial, scope, minted.node_id, attrs);

  if (tagStore !== undefined) {
    try {
      await maybeReconcileInlineTags(
        client,
        dial,
        scope,
        tagStore,
        minted.node_id,
      );
    } catch (err) {
      // Tag reconcile failures do not fail the sink (the C9 stance: a tag
      // failure never fails the body write it rides behind) — but they are
      // loud, because silence is how junk survives.
      const detail =
        err instanceof ChaosClientError || err instanceof Error
          ? err.message
          : String(err);
      console.error(
        `notes-sink: inline-tag reconcile failed for ${minted.node_id}: ${detail}`,
      );
    }
  }

  return { node_id: minted.node_id, created: minted.created, generation };
}

/**
 * Land ONE dissolved document version as its note — mint/reuse the identity,
 * write the body as the next one-block generation (or no-op), reconcile the
 * provenance attributes and the inline tags.
 *
 * `dissolvedAt` is the version's original store timestamp when known (the
 * migration passes the newest row's `created_at`; the live bridge passes
 * nothing and the attribute records the write's own moment downstream of the
 * table row until F7 retires it).
 */
export async function sinkNoteVersion(
  client: BodyClient,
  dial: ChaosDial,
  scope: string,
  tagStore: TagStore | undefined,
  input: WriteDocumentInput,
  dissolvedAt?: string,
): Promise<SinkResult> {
  return landContainer(
    client,
    dial,
    scope,
    tagStore,
    input.source_path,
    [input.body_text],
    provenanceAttrs(input, dissolvedAt),
  );
}

/** `dissolve_note`'s input — a whole container, block-grain (F9). */
export interface DissolveContainerInput {
  source_path: string;
  /** The container's blocks, in display order. */
  blocks: string[];
  title?: string;
  schema_type?: string;
  source_kind?: string;
  mtime?: string;
  ctime?: string;
  file_path?: string;
  /** The local file's own content hash; defaults to sha256 of the blocks
   *  joined with a blank line (the markdown projection separator). */
  raw_hash?: string;
}

/**
 * F9 Dissolve: promote ONE container — its blocks, provenance and tags —
 * into the graph tenant. Per-note, human-chosen; the inversion that retires
 * C6's bulk sweep. Conflict semantics are last-write-wins as a CoW
 * generation (history keeps the old); identical content no-ops.
 */
export async function dissolveContainer(
  client: BodyClient,
  dial: ChaosDial,
  scope: string,
  tagStore: TagStore | undefined,
  input: DissolveContainerInput,
): Promise<SinkResult> {
  const joined = input.blocks.join("\n\n");
  return landContainer(
    client,
    dial,
    scope,
    tagStore,
    input.source_path,
    input.blocks,
    provenanceAttrs({
      source_path: input.source_path,
      body_text: joined,
      ...(input.raw_hash !== undefined ? { raw_hash: input.raw_hash } : {}),
      ...(input.title !== undefined ? { subject: input.title } : {}),
      ...(input.schema_type !== undefined
        ? { schema_type: input.schema_type }
        : {}),
      ...(input.source_kind !== undefined
        ? { source_kind: input.source_kind }
        : {}),
      ...(input.mtime !== undefined ? { mtime: input.mtime } : {}),
      ...(input.ctime !== undefined ? { ctime: input.ctime } : {}),
      ...(input.file_path !== undefined ? { file_path: input.file_path } : {}),
    }),
  );
}
