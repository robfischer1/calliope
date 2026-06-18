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

import type { BodyClient, Section, SectionInput } from "../types.js";

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
