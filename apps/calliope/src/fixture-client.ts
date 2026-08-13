import type {
  AppliedOp,
  ApplySectionOpsResult,
  AuthoredBy,
  BodyClient,
  RevisionMeta,
  Section,
  SectionInput,
  SectionOp,
} from "./types.js";
import {
  SESSION_PRINCIPAL_RE,
  commentContainerOf,
  validateWriteProvenance,
} from "./types.js";
import type { CommentRecord, CommentThread, TargetState } from "./types.js";
import { between, compareKeys, sequence } from "./order-key.js";

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
  authoredBy: AuthoredBy;
  kafkaOffset: number | null;
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
  /** 026 — copy-on-write lineage pairs per container (the supersessions twin). */
  private readonly lineage = new Map<
    string,
    { succ: string; pred: string }[]
  >();
  /** 026 — ids removed by a delete op, per container (tombstone twin). */
  private readonly deleted = new Map<string, Set<string>>();
  /** 026 — commentsOn edges per DOCUMENT container, creation-ordered. */
  private readonly commentEdges = new Map<
    string,
    {
      commentId: string;
      targetId: string;
      author: string;
      kafkaOffset: number | null;
      createdAt: string;
    }[]
  >();
  private seq = 0;
  private lastEventMs = 0;

  /** 026 — record one supersession pair (edit/reorder/split/merge). */
  private supersede(nodeId: string, succ: string, pred: string): void {
    const pairs = this.lineage.get(nodeId) ?? [];
    pairs.push({ succ, pred });
    this.lineage.set(nodeId, pairs);
  }

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

  saveBody(
    nodeId: string,
    sections: SectionInput[],
    authoredBy?: AuthoredBy,
    kafkaOffset?: number,
  ): Promise<void> {
    try {
      validateWriteProvenance(authoredBy ?? "human", kafkaOffset);
    } catch (err) {
      return Promise.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    this.bodies.set(nodeId, this.materialize(nodeId, sections));
    this.record(nodeId, "save", undefined, authoredBy, kafkaOffset);
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
    authoredBy?: AuthoredBy,
    kafkaOffset?: number,
  ): Promise<Section> {
    try {
      validateWriteProvenance(authoredBy ?? "human", kafkaOffset);
    } catch (err) {
      return Promise.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    const rows = this.bodies.get(nodeId);
    const target = rows?.find((r) => r.id === sectionId);
    if (rows === undefined || target === undefined) {
      return Promise.reject(
        new Error(
          `editSection: section ${sectionId} is not part of node ${nodeId}.`,
        ),
      );
    }
    // F4: a byte-identical re-submit is a no-op — no event, same id back.
    if (target.text === text) {
      return Promise.resolve({
        id: target.id,
        text: target.text,
        orderKey: target.orderKey,
      });
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
    this.supersede(nodeId, next.id, sectionId);
    this.record(nodeId, "edit", undefined, authoredBy, kafkaOffset);
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
    authoredBy?: AuthoredBy,
    kafkaOffset?: number,
  ): Promise<ApplySectionOpsResult> {
    try {
      validateWriteProvenance(authoredBy ?? "human", kafkaOffset);
    } catch (err) {
      return Promise.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
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
        this.supersede(nodeId, row.id, op.sectionId);
        applied.push({ id: row.id, orderKey: row.orderKey });
      } else if (op.op === "delete") {
        next = next.filter((r) => r.id !== op.sectionId);
        const gone = this.deleted.get(nodeId) ?? new Set<string>();
        gone.add(op.sectionId);
        this.deleted.set(nodeId, gone);
        applied.push({ id: target.id, orderKey: target.orderKey });
      } else {
        next = next.map((r) =>
          r.id === op.sectionId ? { ...r, orderKey: op.orderKey } : r,
        );
        applied.push({ id: target.id, orderKey: op.orderKey });
      }
    }
    this.bodies.set(nodeId, next);
    this.record(nodeId, "ops", ops.length, authoredBy, kafkaOffset);
    const sections = [...next]
      .sort((a, b) => compareKeys(a.orderKey, b.orderKey))
      .map((r) => ({ id: r.id, text: r.text, orderKey: r.orderKey }));
    return Promise.resolve({ sections, applied });
  }

  /**
   * F3 identity-preserving split — the fixture twin of the sovereign store's
   * `splitSection`. Same visible semantics: two fresh children, first keeps
   * the key, second lands between the original and its next neighbour; one
   * "ops"-kind write-event.
   */
  splitSection(
    nodeId: string,
    sectionId: string,
    offset: number,
    authoredBy?: AuthoredBy,
    kafkaOffset?: number,
  ): Promise<[Section, Section]> {
    try {
      validateWriteProvenance(authoredBy ?? "human", kafkaOffset);
    } catch (err) {
      return Promise.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    if (!Number.isInteger(offset) || offset < 0) {
      return Promise.reject(
        new Error(
          `bad_offset: split offset must be a non-negative integer (got ${String(offset)}).`,
        ),
      );
    }
    const rows = [...(this.bodies.get(nodeId) ?? [])].sort((a, b) =>
      compareKeys(a.orderKey, b.orderKey),
    );
    const idx = rows.findIndex((r) => r.id === sectionId);
    const target = idx >= 0 ? rows[idx] : undefined;
    if (target === undefined) {
      return Promise.reject(
        new Error(
          `stale_section: section ${sectionId} is not part of node ${nodeId}.`,
        ),
      );
    }
    if (offset > target.text.length) {
      return Promise.reject(
        new Error(
          `bad_offset: ${String(offset)} exceeds the block's length ` +
            `(${String(target.text.length)}).`,
        ),
      );
    }
    const next = rows[idx + 1];
    const first: FixtureSection = {
      id: `${nodeId}#${String(this.seq++)}`,
      text: target.text.slice(0, offset),
      orderKey: target.orderKey,
    };
    const second: FixtureSection = {
      id: `${nodeId}#${String(this.seq++)}`,
      text: target.text.slice(offset),
      orderKey: between(target.orderKey, next?.orderKey ?? null),
    };
    this.bodies.set(nodeId, [
      ...rows.filter((r) => r.id !== sectionId),
      first,
      second,
    ]);
    this.supersede(nodeId, first.id, sectionId);
    this.supersede(nodeId, second.id, sectionId);
    this.record(nodeId, "ops", 2, authoredBy, kafkaOffset);
    return Promise.resolve([{ ...first }, { ...second }]);
  }

  /**
   * F3 identity-preserving merge — the fixture twin of the sovereign store's
   * `mergeSections`. Adjacency required; one "edit"-kind write-event.
   */
  mergeSections(
    nodeId: string,
    firstId: string,
    secondId: string,
    separator = "",
    authoredBy?: AuthoredBy,
    kafkaOffset?: number,
  ): Promise<Section> {
    try {
      validateWriteProvenance(authoredBy ?? "human", kafkaOffset);
    } catch (err) {
      return Promise.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    const rows = [...(this.bodies.get(nodeId) ?? [])].sort((a, b) =>
      compareKeys(a.orderKey, b.orderKey),
    );
    const iFirst = rows.findIndex((r) => r.id === firstId);
    const iSecond = rows.findIndex((r) => r.id === secondId);
    const first = iFirst >= 0 ? rows[iFirst] : undefined;
    const second = iSecond >= 0 ? rows[iSecond] : undefined;
    if (first === undefined || second === undefined) {
      return Promise.reject(
        new Error(
          `stale_section: section ${first === undefined ? firstId : secondId} ` +
            `is not part of node ${nodeId}.`,
        ),
      );
    }
    if (iSecond !== iFirst + 1) {
      return Promise.reject(
        new Error(
          `not_adjacent: ${firstId} and ${secondId} are not adjacent in ` +
            `order (merge joins a block with its immediate successor).`,
        ),
      );
    }
    const merged: FixtureSection = {
      id: `${nodeId}#${String(this.seq++)}`,
      text: first.text + separator + second.text,
      orderKey: first.orderKey,
    };
    this.bodies.set(nodeId, [
      ...rows.filter((r) => r.id !== firstId && r.id !== secondId),
      merged,
    ]);
    this.supersede(nodeId, merged.id, firstId);
    this.supersede(nodeId, merged.id, secondId);
    this.record(nodeId, "edit", undefined, authoredBy, kafkaOffset);
    return Promise.resolve({ ...merged });
  }

  /**
   * 026 — the fixture twin of {@link PgBodyClient.createComment}: validate
   * FIRST (atomicity — a rejected comment leaves no block and no edge),
   * then land the block in the derived comment container and the edge in
   * this document's edge list.
   */
  createComment(
    containerId: string,
    targetBlockId: string,
    text: string,
    authoredBy: AuthoredBy,
    kafkaOffset?: number,
  ): Promise<{
    comment: Section;
    targetId: string;
    commentContainerId: string;
  }> {
    try {
      validateWriteProvenance(authoredBy, kafkaOffset);
    } catch (err) {
      return Promise.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    if (!SESSION_PRINCIPAL_RE.test(authoredBy)) {
      return Promise.reject(
        new Error(
          "comment_author_required: a comment is attributed to a session — " +
            "authored_by must be a session principal " +
            "(spiffe://{td}/session/{uuid}).",
        ),
      );
    }
    const cc = commentContainerOf(containerId);
    if (!this.#isKnownBlock(containerId, cc, targetBlockId)) {
      return Promise.reject(
        new Error(
          `stale_section: block ${targetBlockId} is not part of container ` +
            `${containerId} or its comments.`,
        ),
      );
    }
    const current = [...(this.bodies.get(cc) ?? [])].sort((a, b) =>
      compareKeys(a.orderKey, b.orderKey),
    );
    const orderKey = between(current.at(-1)?.orderKey ?? null, null);
    const row: FixtureSection = {
      id: `${cc}#${String(this.seq++)}`,
      text,
      orderKey,
    };
    this.bodies.set(cc, [...(this.bodies.get(cc) ?? []), row]);
    this.record(cc, "ops", 1, authoredBy, kafkaOffset);
    const edges = this.commentEdges.get(containerId) ?? [];
    edges.push({
      commentId: row.id,
      targetId: targetBlockId,
      author: authoredBy,
      kafkaOffset: kafkaOffset ?? null,
      createdAt: new Date(this.lastEventMs).toISOString(),
    });
    this.commentEdges.set(containerId, edges);
    return Promise.resolve({
      comment: { id: row.id, text: row.text, orderKey: row.orderKey },
      targetId: targetBlockId,
      commentContainerId: cc,
    });
  }

  /** 026 — the fixture twin of {@link PgBodyClient.listComments}. */
  listComments(
    containerId: string,
    blockId?: string,
  ): Promise<CommentThread[]> {
    const cc = commentContainerOf(containerId);
    const edges = this.commentEdges.get(containerId) ?? [];
    if (edges.length === 0) return Promise.resolve([]);

    if (blockId !== undefined) {
      const members = this.#lineagePreds(containerId, cc, blockId);
      const mine = edges.filter((e) => members.has(e.targetId));
      if (mine.length === 0) return Promise.resolve([]);
      return Promise.resolve([
        {
          targetId: blockId,
          targetState: this.#targetState(containerId, cc, blockId),
          comments: mine.map((e) => this.#toRecord(cc, e)),
        },
      ]);
    }

    const byTarget = new Map<string, typeof edges>();
    for (const e of edges) {
      const bucket = byTarget.get(e.targetId) ?? [];
      bucket.push(e);
      byTarget.set(e.targetId, bucket);
    }
    return Promise.resolve(
      [...byTarget.entries()].map(([targetId, bucket]) => ({
        targetId,
        targetState: this.#targetState(containerId, cc, targetId),
        comments: bucket.map((e) => this.#toRecord(cc, e)),
      })),
    );
  }

  /** 026 — target known to the document's universe (body, history, comments). */
  #isKnownBlock(containerId: string, cc: string, id: string): boolean {
    const inBody = (n: string): boolean =>
      (this.bodies.get(n) ?? []).some((r) => r.id === id);
    if (inBody(containerId) || inBody(cc)) return true;
    const pairs = [
      ...(this.lineage.get(containerId) ?? []),
      ...(this.lineage.get(cc) ?? []),
    ];
    if (pairs.some((p) => p.pred === id || p.succ === id)) return true;
    return (
      (this.deleted.get(containerId)?.has(id) ?? false) ||
      (this.deleted.get(cc)?.has(id) ?? false)
    );
  }

  /** 026 — {id} ∪ transitive predecessors, across body + comment containers. */
  #lineagePreds(containerId: string, cc: string, id: string): Set<string> {
    const pairs = [
      ...(this.lineage.get(containerId) ?? []),
      ...(this.lineage.get(cc) ?? []),
    ];
    const members = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of pairs) {
        if (members.has(p.succ) && !members.has(p.pred)) {
          members.add(p.pred);
          grew = true;
        }
      }
    }
    return members;
  }

  /** 026 — active | superseded | deleted, walking lineage FORWARD. */
  #targetState(containerId: string, cc: string, id: string): TargetState {
    const active = (n: string): boolean =>
      (this.bodies.get(n) ?? []).some((r) => r.id === id);
    if (active(containerId) || active(cc)) return "active";
    const pairs = [
      ...(this.lineage.get(containerId) ?? []),
      ...(this.lineage.get(cc) ?? []),
    ];
    const gone = new Set([
      ...(this.deleted.get(containerId) ?? []),
      ...(this.deleted.get(cc) ?? []),
    ]);
    const succs = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of pairs) {
        if (succs.has(p.pred) && !succs.has(p.succ)) {
          succs.add(p.succ);
          grew = true;
        }
      }
    }
    for (const s of succs) if (gone.has(s)) return "deleted";
    return "superseded";
  }

  /** 026 — edge → record: original provenance, current prose. */
  #toRecord(
    cc: string,
    e: {
      commentId: string;
      targetId: string;
      author: string;
      kafkaOffset: number | null;
      createdAt: string;
    },
  ): CommentRecord {
    // Follow the comment's own lineage to its current revision's prose.
    const pairs = this.lineage.get(cc) ?? [];
    let currentId = e.commentId;
    let moved = true;
    while (moved) {
      moved = false;
      for (const p of pairs) {
        if (p.pred === currentId) {
          currentId = p.succ;
          moved = true;
        }
      }
    }
    const row = (this.bodies.get(cc) ?? []).find((r) => r.id === currentId);
    return {
      id: e.commentId,
      text: row?.text ?? "",
      author: e.author,
      kafkaOffset: e.kafkaOffset,
      createdAt: e.createdAt,
      commentsOn: e.targetId,
    };
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
          authoredBy: e.authoredBy,
          kafkaOffset: e.kafkaOffset,
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
    authoredBy?: AuthoredBy,
    kafkaOffset?: number,
  ): void {
    const now = Math.max(Date.now(), this.lastEventMs + 1);
    this.lastEventMs = now;
    const snapshot = (this.bodies.get(nodeId) ?? []).map((r) => ({ ...r }));
    const events = this.revisions.get(nodeId) ?? [];
    events.push({
      revision: new Date(now).toISOString(),
      kind,
      authoredBy: authoredBy ?? "human",
      kafkaOffset: kafkaOffset ?? null,
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
