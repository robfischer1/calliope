import type { BodyClient, Section, SectionInput } from "./types.js";
import { compareKeys, sequence } from "./order-key.js";

/**
 * The substrate body model (the predicates this client reads/writes):
 *
 *   note    --hasPart-->   section          (node edge; "hasPart" predicate)
 *   section : hasType "section"              (plain node; a placement id)
 *   section --text-->      "<prose>"         (literal; urania interns it
 *                                             content-addressed into scalars)
 *   section --order_key--> "<key>"           (literal; fractional, COLLATE "C")
 *
 * Edits are copy-on-write: changed prose mints a NEW version (a fresh section
 * node) that supersedes the old; `hasPart` is rewired to the new node.
 *
 * RETIRED — never emitted here: hasBlock, "block" type, block_types, the
 * "body"->bodyArrId handle, hasOrderKey, arrangements / hasMember / place /
 * move / unplace.
 */
export const SECTION_TYPE = "section";
export const HAS_PART = "hasPart";
export const TEXT = "text";
export const ORDER_KEY = "order_key";

/** A capture op against the substrate (urania's mutation vocabulary). */
export type UraniaOp =
  | { op: "createNode"; id: string; hasType: string }
  | { op: "addEdge"; from: string; predicate: string; to: string }
  | { op: "removeEdge"; from: string; predicate: string; to: string };

/** A resolved triple as urania returns it from `resolve` / `present`. */
export interface UraniaTriple {
  from: string;
  predicate: string;
  to: string;
}

/**
 * The transport seam to urania (capture via the Hades gate). This is the only
 * surface the live wiring touches — the analogue of Tantalus's clotho swap-seam.
 * An adapter over the `hades`/`urania` MCP supplies it; the body-model mapping
 * below is transport-agnostic.
 */
export interface UraniaCapture {
  /**
   * Resolve every triple whose subject is `subject` (one hop). Used to read the
   * note's `hasPart` edges and each section's `text` / `order_key` literals.
   */
  resolve(subject: string): Promise<UraniaTriple[]>;
  /** Apply a batch of mutation ops atomically (urania capture via Hades). */
  capture(ops: UraniaOp[]): Promise<void>;
  /** Mint a fresh, unique section placement id under `nodeId`. */
  mintSectionId(nodeId: string): string;
}

/** Default guard: live transport is deferred unless explicitly enabled. */
function wiringEnabled(): boolean {
  // Same posture as Tantalus's clotho seam: off unless an env flag opts in.
  const flag =
    typeof process !== "undefined"
      ? process.env.CALLIOPE_URANIA_WIRED
      : undefined;
  return flag === "1" || flag === "true";
}

/** A capture that throws — the deferred-wire stand-in. */
class UnwiredCapture implements UraniaCapture {
  resolve(): Promise<UraniaTriple[]> {
    return Promise.reject(
      new Error(
        "UraniaBodyClient: live substrate wiring not enabled (set " +
          "CALLIOPE_URANIA_WIRED=1 and inject a UraniaCapture transport).",
      ),
    );
  }
  capture(): Promise<void> {
    return Promise.reject(
      new Error("UraniaBodyClient: live substrate wiring not enabled."),
    );
  }
  mintSectionId(nodeId: string): string {
    return `${nodeId}#section/${crypto.randomUUID()}`;
  }
}

/**
 * Substrate-direct {@link BodyClient}. The body-model mapping is real and
 * complete; the *transport* is deferred. With no wired {@link UraniaCapture}
 * injected, every read/save throws "not wired" (guarded behind
 * `CALLIOPE_URANIA_WIRED`), exactly like Tantalus's current clotho swap-seam.
 *
 * Inject a real transport to go live — the mapping does not change.
 */
export class UraniaBodyClient implements BodyClient {
  private readonly capture: UraniaCapture;

  constructor(capture?: UraniaCapture) {
    if (capture !== undefined && wiringEnabled()) {
      this.capture = capture;
    } else {
      this.capture = new UnwiredCapture();
    }
  }

  /**
   * Read a body: resolve the note's `hasPart` section targets, resolve each to
   * `{ text, order_key }`, return sorted by `orderKey` (COLLATE "C").
   */
  async readBody(nodeId: string): Promise<Section[]> {
    const noteTriples = await this.capture.resolve(nodeId);
    const sectionIds = noteTriples
      .filter((t) => t.predicate === HAS_PART)
      .map((t) => t.to);

    const sections: Section[] = [];
    for (const id of sectionIds) {
      const triples = await this.capture.resolve(id);
      const text = triples.find((t) => t.predicate === TEXT)?.to ?? "";
      const orderKey = triples.find((t) => t.predicate === ORDER_KEY)?.to ?? "";
      sections.push({ id, text, orderKey });
    }
    sections.sort((a, b) => compareKeys(a.orderKey, b.orderKey));
    return sections;
  }

  /**
   * Coarse-save via copy-on-write. Read the current body, then for the new
   * `sections` (in display order, relaid onto a fresh fractional sequence):
   *
   *  - prose changed (or a new position) -> mint a fresh section node
   *    (`hasType section`, `text`, `order_key`) and wire `note --hasPart-->`;
   *  - prose unchanged at this position -> reuse the existing section node, but
   *    rewrite its `order_key` if the position moved (still a new edge, the old
   *    removed).
   *
   * Then unwire (`removeEdge hasPart`) every old section the new body no longer
   * references. The superseded section nodes are left in place — they remain the
   * historical versions the substrate's lineage points at; only `hasPart` moves.
   */
  async saveBody(nodeId: string, sections: SectionInput[]): Promise<void> {
    const current = await this.readBody(nodeId);
    const keys = sequence(sections.length);
    const ops: UraniaOp[] = [];

    // Match new sections to existing ones positionally, reusing a node only when
    // the prose is byte-identical (copy-on-write: changed prose => new version).
    const used = new Set<string>();
    const keptHasPart = new Set<string>();

    // keys is sequence(sections.length) — parallel to sections — so zip them
    // into placements and iterate that, keeping the loop assertion-free.
    const placements = sections.map((section, i) => ({
      text: section.text,
      orderKey: keys[i] ?? "",
    }));
    for (const { text: nextText, orderKey } of placements) {
      const reuse = current.find((c) => c.text === nextText && !used.has(c.id));

      if (reuse !== undefined) {
        used.add(reuse.id);
        keptHasPart.add(reuse.id);
        // Same prose => same content-addressed node; only the order may move.
        if (reuse.orderKey !== orderKey) {
          ops.push({
            op: "removeEdge",
            from: reuse.id,
            predicate: ORDER_KEY,
            to: reuse.orderKey,
          });
          ops.push({
            op: "addEdge",
            from: reuse.id,
            predicate: ORDER_KEY,
            to: orderKey,
          });
        }
        continue;
      }

      // New prose at this position => mint a new version node (copy-on-write).
      const id = this.capture.mintSectionId(nodeId);
      keptHasPart.add(id);
      ops.push({ op: "createNode", id, hasType: SECTION_TYPE });
      ops.push({ op: "addEdge", from: id, predicate: TEXT, to: nextText });
      ops.push({
        op: "addEdge",
        from: id,
        predicate: ORDER_KEY,
        to: orderKey,
      });
      ops.push({ op: "addEdge", from: nodeId, predicate: HAS_PART, to: id });
    }

    // Rewire: drop hasPart for every old section the new body dropped or
    // superseded. (The section node itself stays — it is the prior version.)
    for (const old of current) {
      if (!keptHasPart.has(old.id)) {
        ops.push({
          op: "removeEdge",
          from: nodeId,
          predicate: HAS_PART,
          to: old.id,
        });
      }
    }

    await this.capture.capture(ops);
  }
}
