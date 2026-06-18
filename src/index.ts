/**
 * @forge/calliope — the node-body prose editor. "clotho for prose": a
 * ProseMirror editor over the urania substrate body model
 * (note --hasPart--> section --text/order_key--> …), the Obsidian replacement.
 *
 * The Tantalus <-> Calliope seam is the public surface below: the {@link Section}
 * / {@link SectionInput} shapes, the {@link BodyClient} transport, the
 * {@link NodeBodyEditor} component, and the two clients
 * ({@link FixtureBodyClient} now, {@link UraniaBodyClient} substrate-direct,
 * live wire deferred).
 */
export type { Section, SectionInput, BodyClient } from "./types.js";
export { NodeBodyEditor } from "./NodeBodyEditor.js";
export type { NodeBodyEditorProps } from "./NodeBodyEditor.js";
export { FixtureBodyClient } from "./fixture-client.js";
export {
  UraniaBodyClient,
  SECTION_TYPE,
  HAS_PART,
  TEXT,
  ORDER_KEY,
} from "./urania-client.js";
export type { UraniaCapture, UraniaOp, UraniaTriple } from "./urania-client.js";

// Editor internals, exported for render surfaces that embed Calliope's schema
// (e.g. read-only previews) without driving the full component.
export { schema, textsToDoc, docToTexts } from "./prosemirror.js";
export { between, compareKeys, sequence } from "./order-key.js";
