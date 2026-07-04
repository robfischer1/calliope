/**
 * @forge/calliope — the Notes & Prose Muse's wire. The body service behind
 * `calliope-mcp` (:8204, via Hades): the section body model
 * (note --hasPart--> section --text/order_key--> …) and its transports.
 *
 * The editor surface that used to live here is `@forge/aglaia` (the split,
 * 2026-07-04): Calliope keeps the verbs, Aglaia gets the UI. What remains is
 * service-facing — the {@link Section} / {@link SectionInput} shapes, the
 * {@link BodyClient} transport contract, and the two service backends
 * ({@link UraniaBodyClient} substrate-direct, {@link FixtureBodyClient}
 * in-memory for tests/dev).
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
