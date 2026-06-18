import type { BodyClient, Section, SectionInput } from "./types.js";
import { compareKeys, sequence } from "./order-key.js";

/** An in-memory section row, mirroring the substrate's `{ text, order_key }`. */
interface FixtureSection {
  id: string;
  text: string;
  orderKey: string;
}

/**
 * In-memory {@link BodyClient}. Sections are kept per `nodeId`; this is the
 * default for standalone dev and for Tantalus today — fully working, no wire.
 *
 * It models the substrate semantics it can: a coarse save relays a fresh
 * fractional `order_key` sequence, mints a placement id per section, and reads
 * back sorted by `orderKey` (COLLATE "C"). It does *not* model copy-on-write
 * versioning — that is a substrate concern with no observable effect through the
 * {@link BodyClient} read/save contract.
 */
export class FixtureBodyClient implements BodyClient {
  private readonly bodies = new Map<string, FixtureSection[]>();
  private seq = 0;

  /** Seed a node's body up front (e.g. for stories / standalone demo). */
  constructor(seed?: Record<string, readonly SectionInput[]>) {
    if (seed) {
      for (const [nodeId, sections] of Object.entries(seed)) {
        this.bodies.set(nodeId, this.materialize(nodeId, sections));
      }
    }
  }

  readBody(nodeId: string): Promise<Section[]> {
    const rows = this.bodies.get(nodeId) ?? [];
    const sorted = [...rows]
      .sort((a, b) => compareKeys(a.orderKey, b.orderKey))
      .map((r) => ({ id: r.id, text: r.text, orderKey: r.orderKey }));
    return Promise.resolve(sorted);
  }

  saveBody(nodeId: string, sections: SectionInput[]): Promise<void> {
    this.bodies.set(nodeId, this.materialize(nodeId, sections));
    return Promise.resolve();
  }

  private materialize(
    nodeId: string,
    sections: readonly SectionInput[],
  ): FixtureSection[] {
    const keys = sequence(sections.length);
    return sections.map((s, i) => ({
      id: `${nodeId}#${String(this.seq++)}`,
      text: s.text,
      orderKey: keys[i] as string,
    }));
  }
}
