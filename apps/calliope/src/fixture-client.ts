import type {
  AppliedOp,
  ApplySectionOpsResult,
  BodyClient,
  RevisionMeta,
  Section,
  SectionInput,
  SectionOp,
} from "./types.js";
import { compareKeys, sequence } from "./order-key.js";

/** An in-memory section row, mirroring the substrate's `{ text, order_key }`. */
interface FixtureSection {
  id: string;
  text: string;
  orderKey: string;
}

/** One recorded write-event: the body snapshot after it landed (A8 history). */
interface FixtureRevision {
  revision: string;
  kind: "save" | "edit" | "ops";
  sections: number;
  snapshot: FixtureSection[];
}

/**
 * In-memory {@link BodyClient}. Sections are kept per `nodeId`; this is the
 * default for standalone dev and for Tantalus today — fully working, no wire.
 *
 * It models the substrate semantics it can: a coarse save relays a fresh
 * fractional `order_key` sequence, mints a placement id per section, and reads
 * back sorted by `orderKey` (COLLATE "C"). Copy-on-write versioning is modeled
 * ONLY as far as the A8 history surface observes it: each save/edit records a
 * write-event with a post-event snapshot, so `readRevisions`/`readRevisionAt`
 * behave like the sovereign store's lineage reconstruction (strictly
 * increasing event timestamps, save vs edit kinds, as-of reads).
 */
export class FixtureBodyClient implements BodyClient {
  private readonly bodies = new Map<string, FixtureSection[]>();
  private readonly revisions = new Map<string, FixtureRevision[]>();
  private seq = 0;
  private lastEventMs = 0;

  /** Seed a node's body up front (e.g. for stories / standalone demo). */
  constructor(seed?: Record<string, readonly SectionInput[]>) {
    if (seed) {
      for (const [nodeId, sections] of Object.entries(seed)) {
        this.bodies.set(nodeId, this.materialize(nodeId, sections));
        this.record(nodeId, "save");
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
    this.record(nodeId, "save");
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
    this.record(nodeId, "edit");
    return Promise.resolve({
      id: next.id,
      text: next.text,
      orderKey: next.orderKey,
    });
  }

  /**
   * A11 block-grain transactional apply — the fixture half of the
   * `apply_section_ops` contract. Validates EVERY referenced id first (a
   * stale id rejects the whole batch), then applies with the store
   * semantics: `update` mints a fresh placement id keeping the key unless
   * the op carries one; `add` uses the caller's key; `delete` removes the
   * row; `reorder` moves the key. One `"ops"` revision event per batch.
   */
  applySectionOps(
    nodeId: string,
    ops: SectionOp[],
  ): Promise<ApplySectionOpsResult> {
    const rows = [...(this.bodies.get(nodeId) ?? [])];
    for (const op of ops) {
      if (op.op === "add") continue;
      if (!rows.some((r) => r.id === op.sectionId)) {
        return Promise.reject(
          new Error(
            `stale_section: section ${op.sectionId} is not part of node ${nodeId}.`,
          ),
        );
      }
    }
    const applied: AppliedOp[] = [];
    let next = rows;
    for (const op of ops) {
      if (op.op === "add") {
        const row: FixtureSection = {
          id: `${nodeId}#${String(this.seq++)}`,
          text: op.text,
          orderKey: op.orderKey,
        };
        next = [...next, row];
        applied.push({ id: row.id, orderKey: row.orderKey });
        continue;
      }
      const target = next.find((r) => r.id === op.sectionId);
      if (target === undefined) {
        // Malformed batch (two ops on one id — the contract forbids it).
        return Promise.reject(
          new Error(
            `stale_section: section ${op.sectionId} was consumed earlier in the batch.`,
          ),
        );
      }
      if (op.op === "update") {
        const row: FixtureSection = {
          id: `${nodeId}#${String(this.seq++)}`,
          text: op.text,
          orderKey: op.orderKey ?? target.orderKey,
        };
        next = next.map((r) => (r.id === op.sectionId ? row : r));
        applied.push({ id: row.id, orderKey: row.orderKey });
      } else if (op.op === "delete") {
        next = next.filter((r) => r.id !== op.sectionId);
        applied.push({ id: target.id, orderKey: target.orderKey });
      } else {
        next = next.map((r) =>
          r.id === op.sectionId ? { ...r, orderKey: op.orderKey } : r,
        );
        applied.push({ id: target.id, orderKey: op.orderKey });
      }
    }
    this.bodies.set(nodeId, next);
    this.record(nodeId, "ops", ops.length);
    const sections = [...next]
      .sort((a, b) => compareKeys(a.orderKey, b.orderKey))
      .map((r) => ({ id: r.id, text: r.text, orderKey: r.orderKey }));
    return Promise.resolve({ sections, applied });
  }

  /** List write-events newest first — the fixture half of the A8 contract. */
  readRevisions(nodeId: string, limit = 50): Promise<RevisionMeta[]> {
    const events = this.revisions.get(nodeId) ?? [];
    return Promise.resolve(
      [...events]
        .reverse()
        .slice(0, limit)
        .map((e) => ({
          revision: e.revision,
          kind: e.kind,
          authoredBy: "human",
          sections: e.sections,
        })),
    );
  }

  /** The body as of `revision` — the snapshot the event recorded. */
  readRevisionAt(nodeId: string, revision: string): Promise<Section[]> {
    const events = this.revisions.get(nodeId) ?? [];
    // The body at T = the latest event at or before T (ISO strings compare
    // lexicographically); before the first event there was no body.
    let snapshot: FixtureSection[] = [];
    for (const e of events) {
      if (e.revision <= revision) snapshot = e.snapshot;
      else break;
    }
    return Promise.resolve(
      [...snapshot]
        .sort((a, b) => compareKeys(a.orderKey, b.orderKey))
        .map((r) => ({ id: r.id, text: r.text, orderKey: r.orderKey })),
    );
  }

  /** Record a write-event with a strictly-increasing ISO timestamp. */
  private record(
    nodeId: string,
    kind: "save" | "edit" | "ops",
    opCount?: number,
  ): void {
    const now = Math.max(Date.now(), this.lastEventMs + 1);
    this.lastEventMs = now;
    const snapshot = (this.bodies.get(nodeId) ?? []).map((r) => ({ ...r }));
    const events = this.revisions.get(nodeId) ?? [];
    events.push({
      revision: new Date(now).toISOString(),
      kind,
      sections:
        kind === "edit" ? 1 : kind === "ops" ? (opCount ?? 0) : snapshot.length,
      snapshot,
    });
    this.revisions.set(nodeId, events);
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
