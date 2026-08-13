/**
 * Calliope-MCP tool handlers — the prose facet of the urania substrate.
 *
 * clotho's MCP is the *work/graph* facet (board CRUD over the same nodes);
 * Calliope-MCP is the *body/prose* facet: it writes the node *bodies*
 * (`note --hasPart--> section --text/order_key-->`). The two MCPs are peers
 * over one substrate — clotho builds the plan graph, Calliope writes the plan
 * prose on those same nodes.
 *
 * These handlers are pure functions of a {@link BodyClient}: every read/write
 * goes through the exact client (and body-model mapping) Tantalus and the editor
 * use, so the MCP cannot drift from the lib. Tests drive them over
 * {@link FixtureBodyClient}; production drives them over a wired
 * {@link UraniaBodyClient}. No model is reimplemented here.
 */

import type {
  AuthoredBy,
  BodyClient,
  RevisionMeta,
  Section,
  SectionInput,
  SectionOp,
} from "../types.js";
import {
  type ChaosDial,
  ChaosClientError,
  ensureNotesRoot,
  isNodeToken,
  opAdd,
  opCreate,
  opRemove,
} from "../chaos-client.js";
import {
  computeTagDelta,
  extractInlineTags,
  isJunkTag,
  normalizeTag,
} from "../tags.js";
import type { TagCount, TagStore } from "../tag-store.js";
import { between } from "../order-key.js";

/** A section as the MCP returns it (the lib {@link Section} shape, verbatim). */
export interface ToolSection {
  id: string;
  text: string;
  orderKey: string;
}

/** `read_body` result: the node's sections, sorted by `orderKey` (COLLATE "C"). */
export interface ReadBodyResult {
  sections: ToolSection[];
}

/** `write_body` / coarse-save result. */
export interface WriteBodyResult {
  ok: true;
  count: number;
}

/** `append_section` result: the appended section plus the new body length. */
export interface AppendSectionResult {
  section: ToolSection;
  count: number;
}

/** `edit_section` result: the (copy-on-write) section after the edit. */
export interface EditSectionResult {
  section: ToolSection;
}

/** One `apply_section_ops` op as it rides the wire (snake_case inputs, the
 *  tool convention). */
export interface WireSectionOp {
  op: "add" | "update" | "delete" | "reorder";
  section_id?: string;
  text?: string;
  order_key?: string;
}

/** `apply_section_ops` result: the post-apply body + per-op alignment. */
export interface ApplySectionOpsToolResult {
  sections: ToolSection[];
  applied: { id: string; orderKey: string }[];
}

/** `read_body_revisions` result: the body's write-events, newest first. */
export interface ReadBodyRevisionsResult {
  revisions: RevisionMeta[];
}

/** `read_body_at` result: the body's sections as of a write-event. */
export interface ReadBodyAtResult {
  revision: string;
  sections: ToolSection[];
}

function toToolSection(s: Section): ToolSection {
  return { id: s.id, text: s.text, orderKey: s.orderKey };
}

/**
 * read_body(node_id) -> { sections: [{ id, text, orderKey }] } sorted by
 * orderKey. A node with no body returns `{ sections: [] }`.
 */
export async function readBody(
  client: BodyClient,
  nodeId: string,
): Promise<ReadBodyResult> {
  const sections = await client.readBody(nodeId);
  return { sections: sections.map(toToolSection) };
}

/**
 * write_body(node_id, sections) -> coarse-save: replace the whole body with
 * `sections` (in display order); the substrate mints fresh `order_key`s and
 * copy-on-writes changed prose. Returns `{ ok, count }`.
 */
export async function writeBody(
  client: BodyClient,
  nodeId: string,
  sections: SectionInput[],
  authoredBy?: AuthoredBy,
): Promise<WriteBodyResult> {
  await client.saveBody(nodeId, sections, authoredBy);
  return { ok: true, count: sections.length };
}

/**
 * append_section(node_id, text) -> append ONE section at the end of the body.
 *
 * Implemented as read-current + coarse-save(current + new) so it composes with
 * the existing {@link BodyClient} contract without a new wire verb. The appended
 * section is resolved by reading the body back and taking the last (highest
 * `orderKey`) section — the coarse save mints its placement id and order key.
 */
export async function appendSection(
  client: BodyClient,
  nodeId: string,
  text: string,
  authoredBy?: AuthoredBy,
): Promise<AppendSectionResult> {
  const current = await client.readBody(nodeId);
  const next: SectionInput[] = [
    ...current.map((s) => ({ text: s.text })),
    { text },
  ];
  await client.saveBody(nodeId, next, authoredBy);

  const after = await client.readBody(nodeId);
  const appended = after.at(-1);
  if (appended === undefined) {
    throw new Error(
      `append_section: body of node ${nodeId} was empty after append.`,
    );
  }
  return { section: toToolSection(appended), count: after.length };
}

/**
 * edit_section(node_id, section_id, text) -> single-section copy-on-write edit:
 * replace one section's prose, keeping its order and every other section intact.
 *
 * Requires a {@link BodyClient} that implements the optional `editSection`
 * method (both shipped clients do). Rejects with a clear error if the backend
 * does not support it, rather than silently falling back to a coarse rewrite.
 */
export async function editSection(
  client: BodyClient,
  nodeId: string,
  sectionId: string,
  text: string,
  authoredBy?: AuthoredBy,
): Promise<EditSectionResult> {
  if (client.editSection === undefined) {
    throw new Error(
      "edit_section: the configured body backend does not support " +
        "single-section edits (no editSection method).",
    );
  }
  const section = await client.editSection(nodeId, sectionId, text, authoredBy);
  return { section: toToolSection(section) };
}

/** Decode one wire op into the lib {@link SectionOp}, validating shape. */
function decodeOp(w: WireSectionOp, i: number): SectionOp {
  const need = (field: string): never => {
    throw new Error(
      `apply_section_ops: op[${String(i)}] (${w.op}) is missing ${field}.`,
    );
  };
  if (w.op === "add") {
    return {
      op: "add",
      text: w.text ?? need("text"),
      orderKey: w.order_key ?? need("order_key"),
    };
  }
  if (w.op === "update") {
    return {
      op: "update",
      sectionId: w.section_id ?? need("section_id"),
      text: w.text ?? need("text"),
      ...(w.order_key !== undefined ? { orderKey: w.order_key } : {}),
    };
  }
  if (w.op === "delete") {
    return { op: "delete", sectionId: w.section_id ?? need("section_id") };
  }
  return {
    op: "reorder",
    sectionId: w.section_id ?? need("section_id"),
    orderKey: w.order_key ?? need("order_key"),
  };
}

/**
 * apply_section_ops(node_id, ops) -> { sections, applied } — the A11
 * block-grain transactional write. ALL ops apply or none; per-op semantics
 * are the `edit_section` copy-on-write engine generalized. A stale
 * `section_id` rejects with a `stale_section` error (the editor's
 * compare-before-write race backstop). Requires a {@link BodyClient} with
 * the optional `applySectionOps` — the store-backed backends implement it;
 * the fs backend deliberately does NOT (0.14: files carry no durable
 * section identity, and the editor degrades to whole-body writes).
 */
export async function applySectionOps(
  client: BodyClient,
  nodeId: string,
  ops: WireSectionOp[],
  authoredBy?: AuthoredBy,
): Promise<ApplySectionOpsToolResult> {
  if (client.applySectionOps === undefined) {
    throw new Error(
      "apply_section_ops: the configured body backend does not support " +
        "block-grain applies (no applySectionOps method).",
    );
  }
  const decoded = ops.map((w, i) => decodeOp(w, i));
  const result = await client.applySectionOps(nodeId, decoded, authoredBy);
  return {
    sections: result.sections.map(toToolSection),
    applied: result.applied.map((a) => ({ id: a.id, orderKey: a.orderKey })),
  };
}

/**
 * read_body_revisions(node_id, limit?) -> { revisions } — the body's stored
 * write-events, newest first (A8's history surface). Requires a
 * {@link BodyClient} implementing the optional `readRevisions`; rejects with
 * a clear error otherwise (mirrors the `edit_section` guard).
 */
export async function readBodyRevisions(
  client: BodyClient,
  nodeId: string,
  limit?: number,
): Promise<ReadBodyRevisionsResult> {
  if (client.readRevisions === undefined) {
    throw new Error(
      "read_body_revisions: the configured body backend does not support " +
        "revision reads (no readRevisions method).",
    );
  }
  const revisions = await client.readRevisions(nodeId, limit);
  return { revisions };
}

/**
 * read_body_at(node_id, revision) -> { revision, sections } — the body
 * reconstructed as of the write-event `revision` (a value returned by
 * `read_body_revisions`). A revision predating the body yields `[]`.
 */
export async function readBodyAt(
  client: BodyClient,
  nodeId: string,
  revision: string,
): Promise<ReadBodyAtResult> {
  if (client.readRevisionAt === undefined) {
    throw new Error(
      "read_body_at: the configured body backend does not support " +
        "revision reads (no readRevisionAt method).",
    );
  }
  const sections = await client.readRevisionAt(nodeId, revision);
  return { revision, sections: sections.map(toToolSection) };
}

// ── F3: the block-native verb surface ────────────────────────────────────────

/** A single-block result — the block verbs' common success shape. */
export interface BlockResult {
  block: ToolSection;
}

/** `read_block` structured miss — surfaced, never thrown (a read miss is an
 *  answer, not a fault; write-path staleness still throws `stale_section`). */
export interface BlockMiss {
  error: "block_not_found";
  detail: string;
}

/** Type guard for the miss shape. */
export function isBlockMiss(r: BlockResult | BlockMiss): r is BlockMiss {
  return "error" in r;
}

/** `delete_block` result. */
export interface DeleteBlockResult {
  ok: true;
  deleted: { id: string; orderKey: string };
}

/** `split_block` result: the two children, in order. */
export interface SplitBlockResult {
  blocks: [ToolSection, ToolSection];
}

/**
 * create_block(container_id, text, after_block_id?) -> { block } — mint one
 * block. Position: after the named sibling, or appended at the end when no
 * position is given. The fractional key is minted SERVER-side
 * (`between(after, next)`), so callers never learn key grammar — that stays
 * `apply_section_ops`' contract for the editor. A stale `after_block_id`
 * rejects with `stale_section`.
 */
export async function createBlock(
  client: BodyClient,
  nodeId: string,
  text: string,
  afterBlockId?: string,
  authoredBy?: AuthoredBy,
): Promise<BlockResult> {
  if (client.applySectionOps === undefined) {
    throw new Error(
      "create_block: the configured body backend does not support " +
        "block-grain writes (no applySectionOps method).",
    );
  }
  const body = await client.readBody(nodeId);
  let prevKey: string | null;
  let nextKey: string | null;
  if (afterBlockId !== undefined) {
    const idx = body.findIndex((s) => s.id === afterBlockId);
    const anchor = idx >= 0 ? body[idx] : undefined;
    if (anchor === undefined) {
      throw new Error(
        `stale_section: block ${afterBlockId} is not part of container ${nodeId}.`,
      );
    }
    prevKey = anchor.orderKey;
    nextKey = body[idx + 1]?.orderKey ?? null;
  } else {
    prevKey = body.at(-1)?.orderKey ?? null;
    nextKey = null;
  }
  const orderKey = between(prevKey, nextKey);
  const result = await client.applySectionOps(
    nodeId,
    [{ op: "add", text, orderKey }],
    authoredBy,
  );
  const applied = result.applied.at(0);
  if (applied === undefined) {
    throw new Error(`create_block: the store applied no op for ${nodeId}.`);
  }
  return { block: { id: applied.id, text, orderKey: applied.orderKey } };
}

/** One entry of a section-container index (F5): the address, never the prose. */
export interface ContainerBlockRef {
  id: string;
  /** The block's first non-empty line, trimmed, capped at 80 chars. */
  title: string;
  /** The block's character count (UTF-16 units of its text). */
  chars: number;
  /** The fractional order key (byte-ordered). */
  order_key: string;
}

/** `list_blocks` result for the node family. */
export interface ListContainerBlocksResult {
  container_id: string;
  kind: "node";
  block_count: number;
  blocks: ContainerBlockRef[];
}

/**
 * list_blocks(container_id) — the node-family container index (F5): block
 * ids, first-line titles, sizes and order, with NO prose crossing the wire.
 * The general form that `read_plan`'s whole-plan index special-cased.
 */
export async function listContainerBlocks(
  client: BodyClient,
  nodeId: string,
): Promise<ListContainerBlocksResult> {
  const sections = await client.readBody(nodeId);
  const blocks = sections.map((s) => {
    const firstLine =
      s.text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? "";
    return {
      id: s.id,
      title: firstLine.slice(0, 80),
      chars: s.text.length,
      order_key: s.orderKey,
    };
  });
  return {
    container_id: nodeId,
    kind: "node",
    block_count: blocks.length,
    blocks,
  };
}

/**
 * read_block(container_id, block_id) -> { block } | block_not_found — serve
 * ONE block's content; only that block's markdown crosses the wire.
 */
export async function readBlock(
  client: BodyClient,
  nodeId: string,
  blockId: string,
): Promise<BlockResult | BlockMiss> {
  const body = await client.readBody(nodeId);
  const section = body.find((s) => s.id === blockId);
  if (section === undefined) {
    return {
      error: "block_not_found",
      detail: `block ${blockId} is not part of container ${nodeId}`,
    };
  }
  return { block: toToolSection(section) };
}

/**
 * update_block(container_id, block_id, text) -> { block } — one superseding
 * row; the container's other blocks are untouched and shared by reference
 * (the {@link editSection} copy-on-write engine, block-named).
 */
export async function updateBlock(
  client: BodyClient,
  nodeId: string,
  blockId: string,
  text: string,
  authoredBy?: AuthoredBy,
): Promise<BlockResult> {
  const result = await editSection(client, nodeId, blockId, text, authoredBy);
  return { block: result.section };
}

/**
 * delete_block(container_id, block_id) -> { ok, deleted } — the block leaves
 * the body; history preserves it (tombstone lineage on the store backends).
 */
export async function deleteBlock(
  client: BodyClient,
  nodeId: string,
  blockId: string,
  authoredBy?: AuthoredBy,
): Promise<DeleteBlockResult> {
  if (client.applySectionOps === undefined) {
    throw new Error(
      "delete_block: the configured body backend does not support " +
        "block-grain writes (no applySectionOps method).",
    );
  }
  const result = await client.applySectionOps(
    nodeId,
    [{ op: "delete", sectionId: blockId }],
    authoredBy,
  );
  const applied = result.applied.at(0);
  if (applied === undefined) {
    throw new Error(`delete_block: the store applied no op for ${nodeId}.`);
  }
  return { ok: true, deleted: { id: applied.id, orderKey: applied.orderKey } };
}

/**
 * split_block(container_id, block_id, offset) -> { blocks: [first, second] }
 * — the Enter-mid-paragraph gesture as an identity-preserving op: both
 * children trace to the original through the lineage record.
 */
export async function splitBlock(
  client: BodyClient,
  nodeId: string,
  blockId: string,
  offset: number,
  authoredBy?: AuthoredBy,
): Promise<SplitBlockResult> {
  if (client.splitSection === undefined) {
    throw new Error(
      "split_block: the configured body backend does not support " +
        "identity-preserving splits (no splitSection method).",
    );
  }
  const [first, second] = await client.splitSection(
    nodeId,
    blockId,
    offset,
    authoredBy,
  );
  return { blocks: [toToolSection(first), toToolSection(second)] };
}

/**
 * merge_block(container_id, first_block_id, second_block_id, separator?) ->
 * { block } — the Backspace-at-block-start gesture: two ADJACENT blocks
 * become one whose lineage records BOTH parents.
 */
export async function mergeBlock(
  client: BodyClient,
  nodeId: string,
  firstBlockId: string,
  secondBlockId: string,
  separator?: string,
  authoredBy?: AuthoredBy,
): Promise<BlockResult> {
  if (client.mergeSections === undefined) {
    throw new Error(
      "merge_block: the configured body backend does not support " +
        "identity-preserving merges (no mergeSections method).",
    );
  }
  const section = await client.mergeSections(
    nodeId,
    firstBlockId,
    secondBlockId,
    separator,
    authoredBy,
  );
  return { block: toToolSection(section) };
}

// ── C8: the note-native mint ─────────────────────────────────────────────────

/** `create_note` success: the note's identity (+ whether this call minted it). */
export interface CreateNoteResult {
  node_id: string;
  created: boolean;
}

/** `create_note` structured miss — surfaced, never thrown. */
export interface CreateNoteError {
  error: "bad_title" | "bad_parent" | "bad_tags" | "admit_refused";
  detail: string;
  violations?: unknown[];
}

/** Type guard for the miss shape. */
export function isCreateNoteError(
  r: CreateNoteResult | CreateNoteError,
): r is CreateNoteError {
  return "error" in r;
}

/** The kind + type label a minted note carries. */
export const NOTE_KIND = "Note";

/**
 * create_note(title, parent?, tags?) -> { node_id, created } — the C8 mint.
 *
 * Reuse-first (the F2 identity contract: `createNode` never dedups, so the
 * name is looked up before any mint — `(Note, title)` IS the idempotency key);
 * on a miss, the two-admit mint (createNode → `minted[0]`, then the edge
 * batch: `hasName`, `hasType:"Note"`, `parent`) on the notes scope. A
 * parentless note parents to the ensured "Notes" root — orphan-safety
 * regardless of caller. `tags` is validated and otherwise inert (C9 wires the
 * `hasTag` write). No section rows mint — the body is the node's (empty)
 * section set, readable immediately; first write attaches sections.
 */
export async function createNote(
  dial: ChaosDial,
  scope: string,
  input: { title: string; parent?: string; tags?: string[] },
  tagStore?: TagStore,
): Promise<CreateNoteResult | CreateNoteError> {
  const title = input.title.trim();
  if (title.length === 0) {
    return { error: "bad_title", detail: "title must be non-empty" };
  }
  if (input.tags?.some((t) => t.trim() === "")) {
    return { error: "bad_tags", detail: "tags must be non-empty strings" };
  }
  // F11: hex-color-shaped tokens are junk on the explicit path too.
  const junk = input.tags?.find((t) => isJunkTag(normalizeTag(t)));
  if (junk !== undefined) {
    return {
      error: "bad_tags",
      detail: `tag ${junk} is hex-color-shaped (rejected by the F11 hygiene rule)`,
    };
  }

  // Lazy parent resolve — shared by the mint and the heal-on-reuse paths.
  const resolveParent = async (): Promise<string | CreateNoteError> => {
    if (input.parent === undefined) {
      try {
        return await ensureNotesRoot(dial, scope);
      } catch (err) {
        if (err instanceof ChaosClientError && err.code === "admit_refused") {
          return {
            error: "admit_refused",
            detail: err.message,
            violations: err.violations,
          };
        }
        throw err;
      }
    }
    if (!isNodeToken(input.parent)) {
      return {
        error: "bad_parent",
        detail: "parent must be a 64-hex node token",
      };
    }
    const known = await dial.resolveNodes([input.parent]);
    if (!(input.parent in known)) {
      return {
        error: "bad_parent",
        detail: `parent ${input.parent} is not on the node dictionary`,
      };
    }
    return input.parent;
  };

  const edgeBatch = (token: string, parent: string) => [
    opAdd(token, "hasName", { toLiteral: title }),
    opAdd(token, "hasType", { toLiteral: NOTE_KIND }),
    opAdd(token, "parent", { toNode: parent }),
  ];

  const standing = await dial.findByName(NOTE_KIND, title);
  if (standing.length > 0) {
    const [node] = [...standing].sort();
    if (node === undefined) {
      return { error: "admit_refused", detail: "empty standing set" };
    }
    // Heal an interrupted mint: a dictionary row whose edge admit never
    // landed (the invisible-row trap) gets its edges re-asserted here, so
    // idempotent re-runs converge instead of returning a broken node.
    const existing = await dial.edges(node);
    if (!existing.some((e) => e.predicate === "hasName")) {
      const parent = await resolveParent();
      if (typeof parent !== "string") {
        return parent;
      }
      const healed = await dial.admit(edgeBatch(node, parent), scope);
      if (!healed.admitted) {
        return {
          error: "admit_refused",
          detail: `the gate refused the healing edge batch for ${node}`,
          violations: healed.violations,
        };
      }
    }
    if (tagStore !== undefined && input.tags !== undefined) {
      await reconcileNoteTags(dial, scope, tagStore, node, {
        explicit: input.tags,
      });
    }
    return { node_id: node, created: false };
  }

  const parent = await resolveParent();
  if (typeof parent !== "string") {
    return parent;
  }

  const mint = await dial.admit([opCreate(NOTE_KIND, title)], scope);
  if (!mint.admitted || mint.minted.length !== 1) {
    return {
      error: "admit_refused",
      detail: "the gate refused the mint",
      violations: mint.violations,
    };
  }
  const [token] = mint.minted;
  if (token === undefined) {
    return {
      error: "admit_refused",
      detail: "the gate admitted but returned no minted token",
      violations: mint.violations,
    };
  }

  const edges = await dial.admit(edgeBatch(token, parent), scope);
  if (!edges.admitted) {
    return {
      error: "admit_refused",
      detail:
        `the gate refused the edge batch for ${token} — the node is a ` +
        "dictionary row without its edges; an identical re-run heals it " +
        "(the reuse path re-asserts the missing edges)",
      violations: edges.violations,
    };
  }

  if (tagStore !== undefined && input.tags !== undefined) {
    await reconcileNoteTags(dial, scope, tagStore, token, {
      explicit: input.tags,
    });
  }

  return { node_id: token, created: true };
}

// ── C9: the tag path ─────────────────────────────────────────────────────────

/** The graph predicate a note's tags ride. */
export const HAS_TAG = "hasTag";

/**
 * Reconcile a note's `hasTag` edges + mirror rows against the given sets.
 * The graph writes first (it is the truth); the mirror follows. Explicit
 * rows survive every inline reconcile (provenance rides the mirror).
 */
export async function reconcileNoteTags(
  dial: ChaosDial,
  scope: string,
  store: TagStore,
  nodeId: string,
  next: { inline?: string[]; explicit?: string[] },
): Promise<{ added: string[]; removed: string[] }> {
  const standing = await store.byNode(nodeId);
  const delta = computeTagDelta(standing, next);
  if (delta.toAdd.length === 0 && delta.toRemove.length === 0) {
    return { added: [], removed: [] };
  }
  const ops = [
    ...delta.toAdd.map((r) => opAdd(nodeId, HAS_TAG, { toLiteral: r.tag })),
    ...delta.toRemove.map((tag) =>
      opRemove(nodeId, HAS_TAG, { toLiteral: tag }),
    ),
  ];
  const res = await dial.admit(ops, scope);
  if (!res.admitted) {
    throw new ChaosClientError(
      `reconcileNoteTags: the gate refused the tag batch for ${nodeId}`,
      "admit_refused",
      res.violations,
    );
  }
  for (const r of delta.toAdd) {
    await store.upsert(nodeId, r.tag, r.source);
  }
  for (const tag of delta.toRemove) {
    await store.remove(nodeId, tag);
  }
  return {
    added: delta.toAdd.map((r) => r.tag),
    removed: delta.toRemove,
  };
}

/**
 * The body-write hook: for a Note-kind node (kind-gated via the node's
 * `hasType` edge — work-node prose never enters the tag path), extract the
 * body's inline tags and reconcile. Reads the CURRENT body from the client
 * so every write shape (coarse, append, edit, block ops) feeds one path.
 */
export async function maybeReconcileInlineTags(
  client: BodyClient,
  dial: ChaosDial,
  scope: string,
  store: TagStore,
  nodeId: string,
): Promise<void> {
  const edges = await dial.edges(nodeId);
  const isNote = edges.some(
    (e) => e.predicate === "hasType" && e.value === NOTE_KIND,
  );
  if (!isNote) {
    return;
  }
  const sections = await client.readBody(nodeId);
  const text = sections.map((s) => s.text).join("\n");
  await reconcileNoteTags(dial, scope, store, nodeId, {
    inline: extractInlineTags(text),
  });
}

/** `list_by_tag(tag)` — the graph's indexed point lookup, server-side. */
export async function listByTag(
  dial: ChaosDial,
  scope: string,
  tag: string,
): Promise<{ tag: string; node_ids: string[] }> {
  const norm = normalizeTag(tag);
  const node_ids = await dial.findByValue(scope, HAS_TAG, norm);
  return { tag: norm, node_ids };
}

/** `list_tags()` — the distinct set with counts (the mirror's enumeration). */
export async function listTags(store: TagStore): Promise<{ tags: TagCount[] }> {
  return { tags: await store.distinct() };
}
