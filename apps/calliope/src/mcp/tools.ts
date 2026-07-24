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
import { computeTagDelta, extractInlineTags, normalizeTag } from "../tags.js";
import type { TagCount, TagStore } from "../tag-store.js";

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
): Promise<WriteBodyResult> {
  await client.saveBody(nodeId, sections);
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
): Promise<AppendSectionResult> {
  const current = await client.readBody(nodeId);
  const next: SectionInput[] = [
    ...current.map((s) => ({ text: s.text })),
    { text },
  ];
  await client.saveBody(nodeId, next);

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
): Promise<EditSectionResult> {
  if (client.editSection === undefined) {
    throw new Error(
      "edit_section: the configured body backend does not support " +
        "single-section edits (no editSection method).",
    );
  }
  const section = await client.editSection(nodeId, sectionId, text);
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
 * the optional `applySectionOps` (both shipped backends implement it).
 */
export async function applySectionOps(
  client: BodyClient,
  nodeId: string,
  ops: WireSectionOp[],
): Promise<ApplySectionOpsToolResult> {
  if (client.applySectionOps === undefined) {
    throw new Error(
      "apply_section_ops: the configured body backend does not support " +
        "block-grain applies (no applySectionOps method).",
    );
  }
  const decoded = ops.map((w, i) => decodeOp(w, i));
  const result = await client.applySectionOps(nodeId, decoded);
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
