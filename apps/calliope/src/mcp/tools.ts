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
