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

  /**
   * Single-section edit. Finds the row by `sectionId`, rewrites its prose while
   * keeping its `orderKey` (so body order is untouched), and mints a fresh
   * placement id — mirroring the substrate's copy-on-write identity change.
   * Rejects if `sectionId` is not a current section of `nodeId`.
   */
  editSection(
    nodeId: string,
    sectionId: string,
    text: string,
  ): Promise<Section> {
    const rows = this.bodies.get(nodeId);
    const target = rows?.find((r) => r.id === sectionId);
    if (rows === undefined || target === undefined) {
      return Promise.reject(
        new Error(
          `editSection: section ${sectionId} is not part of node ${nodeId}.`,
        ),
      );
    }
    const next: FixtureSection = {
      id: `${nodeId}#${String(this.seq++)}`,
      text,
      orderKey: target.orderKey,
    };
    this.bodies.set(
      nodeId,
      rows.map((r) => (r.id === sectionId ? next : r)),
    );
    return Promise.resolve({
      id: next.id,
      text: next.text,
      orderKey: next.orderKey,
    });
  }

  private materialize(
    nodeId: string,
    sections: readonly SectionInput[],
  ): FixtureSection[] {
    const keys = sequence(sections.length);
    return keys.map((orderKey, i) => ({
      id: `${nodeId}#${String(this.seq++)}`,
      text: sections[i]?.text ?? "",
      orderKey,
    }));
  }
}
