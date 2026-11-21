/**
 * @forge/calliope — the Notes & Prose Muse's wire. The body service behind
 * `calliope-mcp` (:8204, via Hades): the section body model
 * (note --hasPart--> section --text/order_key--> …) and its transports.
 */
export type {
  Section,
  SectionInput,
  BodyClient,
  BlockOp,
  BlockOpEmitter,
} from "./types.js";
export { FixtureBodyClient } from "./fixture-client.js";
export {
  UraniaBodyClient,
  SECTION_TYPE,
  HAS_PART,
  TEXT,
  ORDER_KEY,
} from "./urania-client.js";
export type { UraniaCapture, UraniaOp, UraniaTriple } from "./urania-client.js";
export { between, compareKeys, sequence } from "./order-key.js";

export {
  PgDocumentStore,
  FixtureDocumentStore,
  sha256 as documentSha256,
} from "./document-store.js";
export type {
  DocumentStore,
  DocumentRow,
  WriteDocumentInput,
  WriteDocumentResult,
  ListDocumentsQuery,
} from "./document-store.js";

export { PgRevisionStore, FixtureRevisionStore } from "./revision-store.js";
export type {
  RevisionStore,
  RevisionRow,
  RevisionDeltaRow,
  RevisionQuery,
} from "./revision-store.js";
