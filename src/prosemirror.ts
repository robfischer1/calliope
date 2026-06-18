import { Schema, type Node as PMNode } from "prosemirror-model";

/**
 * A deliberately minimal block schema — paragraphs and (h2) headings only.
 * Each top-level block maps 1:1 to a substrate `section` (a `text` literal).
 *
 * Granularity is intentionally arbitrary at this stage: a deferred merge/split
 * task owns chunking. Today every top-level ProseMirror block is one section.
 */
export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    heading: {
      group: "block",
      content: "inline*",
      defining: true,
      parseDOM: [{ tag: "h2" }],
      toDOM: () => ["h2", 0],
    },
    text: { group: "inline" },
  },
  marks: {},
});

/**
 * The heading marker. The body model gives a section a single `text` literal and
 * no kind, so heading-ness is carried *in the prose* as a leading `## ` (the
 * markdown convention). The substrate stores the literal verbatim; render
 * surfaces re-derive the block kind from this prefix. Round-trips losslessly.
 */
const HEADING_PREFIX = "## ";

/** Serialize one ProseMirror block to its section `text` literal. */
function blockToText(node: PMNode): string {
  if (node.type.name === "heading") {
    return HEADING_PREFIX + node.textContent;
  }
  return node.textContent;
}

/** Build a ProseMirror block node from a section's `text` literal. */
function textToBlock(text: string): PMNode {
  if (text.startsWith(HEADING_PREFIX)) {
    const body = text.slice(HEADING_PREFIX.length);
    const content = body !== "" ? [schema.text(body)] : [];
    return schema.nodes.heading.create(null, content);
  }
  const content = text !== "" ? [schema.text(text)] : [];
  return schema.nodes.paragraph.create(null, content);
}

/**
 * Build a ProseMirror doc from a body's section texts (in display order).
 * An empty body yields a single blank paragraph (the schema needs `block+`).
 */
export function textsToDoc(texts: readonly string[]): PMNode {
  const nodes = texts.map(textToBlock);
  return schema.nodes.doc.create(
    null,
    nodes.length > 0 ? nodes : [schema.nodes.paragraph.create()],
  );
}

/**
 * Read the doc's top-level blocks back out as section `text` literals, for a
 * coarse save. Blank blocks are dropped so an empty editor saves an empty body.
 */
export function docToTexts(doc: PMNode): string[] {
  const texts: string[] = [];
  doc.forEach((node) => {
    const text = blockToText(node);
    if (text.trim() !== "" && text !== HEADING_PREFIX.trim()) {
      texts.push(text);
    }
  });
  return texts;
}
