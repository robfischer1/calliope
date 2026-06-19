import type { Node as PMNode } from "prosemirror-model";
import {
  schema as markdownSchema,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
} from "prosemirror-markdown";

/**
 * The body's rich-text schema is prosemirror-markdown's CommonMark schema —
 * headings (all levels), `em`/`strong`/`code`/`link` marks, bullet & ordered
 * lists, blockquotes, code blocks, images, and rules.
 *
 * A node's body is authored as markdown (the projecter writes it; Obsidian is
 * the heritage), so the editor parses that markdown into a real document and
 * renders it **formatted** — rather than the old paragraph+`## `-prefix schema,
 * which showed the literal `**`, `##`, and `-` source as plain text.
 *
 * The substrate body model is unchanged: a body is `note --hasPart--> section
 * --text/order_key-->`, each section a `text` literal. Calliope joins a body's
 * section texts into one markdown document for display and serializes the edited
 * document back to a single section on save — one section is the whole body, the
 * unit the projecter writes. Finer per-block section chunking is the deferred
 * merge/split task.
 */
export const schema = markdownSchema;

/** Sections are concatenated as markdown blocks, blank-line separated. */
const SECTION_SEP = "\n\n";

/** An empty body still needs a `block+` doc — a single blank paragraph. */
function emptyDoc(): PMNode {
  return markdownSchema.node("doc", null, [markdownSchema.node("paragraph")]);
}

/**
 * Build a ProseMirror doc from a body's section texts (in display order) by
 * parsing their concatenation as one markdown document. An empty body yields a
 * single blank paragraph (the schema needs `block+`).
 */
export function textsToDoc(texts: readonly string[]): PMNode {
  const md = texts.join(SECTION_SEP).trim();
  if (md === "") return emptyDoc();
  return defaultMarkdownParser.parse(md);
}

/**
 * Serialize the doc back to body section texts for a coarse save. The whole doc
 * round-trips to one markdown string (one section = one body; see {@link
 * schema}). An empty doc saves an empty body (`[]`).
 */
export function docToTexts(doc: PMNode): string[] {
  const md = defaultMarkdownSerializer.serialize(doc).trim();
  return md === "" ? [] : [md];
}
