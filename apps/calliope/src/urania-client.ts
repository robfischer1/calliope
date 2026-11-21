import type {
  AppliedOp,
  ApplySectionOpsResult,
  AuthoredBy,
  BlockOp,
  BlockOpEmitter,
  BodyClient,
  RevisionMeta,
  Section,
  SectionInput,
  SectionOp,
} from "./types.js";
import { compareKeys, sequence } from "./order-key.js";

/** No-op emitter used when no {@link BlockOpEmitter} is injected. */
const NULL_EMITTER: BlockOpEmitter = { emit: () => undefined };

/** The substrate body model (the predicates this client reads/writes): */
export const SECTION_TYPE = "section";
export const HAS_PART = "hasPart";
export const TEXT = "text";
export const ORDER_KEY = "order_key";

/**
 * The provenance identity carried on every body write. Defined in `types.ts`
 * since 024 (the widened union admits a SPIFFE session principal); re-exported
 * here so existing importers keep their path.
 */
export {
  SESSION_PRINCIPAL_RE,
  isAuthoredBy,
  type AuthoredBy,
  type SessionPrincipal,
} from "./types.js";

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
  capture(ops: UraniaOp[], authoredBy?: AuthoredBy): Promise<void>;
  /** Mint a fresh, unique section placement id under `nodeId`. */
  mintSectionId(nodeId?: string): string;
}

/** Default guard: live transport is deferred unless explicitly enabled. */
function wiringEnabled(): boolean {
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
  mintSectionId(nodeId?: string): string {
    return `${nodeId ?? ""}#section/${crypto.randomUUID()}`;
  }
}

/**
 * Substrate-direct {@link BodyClient}. The body-model mapping is real and
 * complete; the *transport* is deferred. With no wired {@link UraniaCapture}
 * injected, every read/save throws "not wired" (guarded behind
 * `CALLIOPE_URANIA_WIRED`), exactly like Tantalus's current clotho swap-seam.
 */
export class UraniaBodyClient implements BodyClient {
  private readonly capture: UraniaCapture;
  private readonly blockOpEmitter: BlockOpEmitter;

  constructor(capture?: UraniaCapture, blockOpEmitter?: BlockOpEmitter) {
    if (capture !== undefined && wiringEnabled()) {
      this.capture = capture;
    } else {
      this.capture = new UnwiredCapture();
    }
    this.blockOpEmitter = blockOpEmitter ?? NULL_EMITTER;
  }

  /** Mint an ISO-8601 UTC timestamp for block-op records. */
  private timestamp(): string {
    return new Date().toISOString();
  }

  /** Emit a single block-op record to the side-channel log. */
  private async emitBlockOp(op: BlockOp): Promise<void> {
    await this.blockOpEmitter.emit(op);
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
   */
  async saveBody(
    nodeId: string,
    sections: SectionInput[],
    authoredBy: AuthoredBy = "human",
  ): Promise<void> {
    const current = await this.readBody(nodeId);
    const keys = sequence(sections.length);
    const ops: UraniaOp[] = [];

    const used = new Set<string>();
    const keptHasPart = new Set<string>();

    const blockOps: BlockOp[] = [];
    const ts = this.timestamp();

    const placements = sections.map((section, i) => ({
      text: section.text,
      orderKey: keys[i] ?? "",
    }));
    for (const { text: nextText, orderKey } of placements) {
      const reuse = current.find((c) => c.text === nextText && !used.has(c.id));

      if (reuse !== undefined) {
        used.add(reuse.id);
        keptHasPart.add(reuse.id);
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
          blockOps.push({
            block_id: reuse.id,
            op_type: "reorder",
            content_delta: "",
            order_key: orderKey,
            timestamp: ts,
            authored_by: authoredBy,
            node_id: nodeId,
          });
        }
        continue;
      }

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

      const hadPriorAtSlot = current.some((c) => !used.has(c.id));
      blockOps.push({
        block_id: id,
        op_type: hadPriorAtSlot ? "update" : "add",
        content_delta: nextText,
        order_key: orderKey,
        timestamp: ts,
        authored_by: authoredBy,
        node_id: nodeId,
      });
    }

    for (const old of current) {
      if (!keptHasPart.has(old.id)) {
        ops.push({
          op: "removeEdge",
          from: nodeId,
          predicate: HAS_PART,
          to: old.id,
        });
        const coveredByUpdate = blockOps.some(
          (b) => b.op_type === "update" && !keptHasPart.has(old.id),
        );
        if (!coveredByUpdate) {
          blockOps.push({
            block_id: old.id,
            op_type: "delete",
            content_delta: "",
            order_key: old.orderKey,
            timestamp: ts,
            authored_by: authoredBy,
            node_id: nodeId,
          });
        }
      }
    }

    await this.capture.capture(ops, authoredBy);

    for (const blockOp of blockOps) {
      await this.emitBlockOp(blockOp);
    }
  }

  /**
   * Single-section copy-on-write edit. Resolve the current body, locate
   * `sectionId`, and mint a fresh version node carrying the new `text` at the
   * SAME `order_key`; rewire `note --hasPart-->` from the old section to the new
   * (the old node is left in place as the prior version). Every other section is
   * untouched — this is the fine-grained counterpart to {@link saveBody}, which
   * reconciles the whole body.
   */
  async editSection(
    nodeId: string,
    sectionId: string,
    text: string,
    authoredBy: AuthoredBy = "human",
  ): Promise<Section> {
    const current = await this.readBody(nodeId);
    const target = current.find((s) => s.id === sectionId);
    if (target === undefined) {
      throw new Error(
        `editSection: section ${sectionId} is not part of node ${nodeId}.`,
      );
    }

    const id = this.capture.mintSectionId(nodeId);
    const ops: UraniaOp[] = [
      { op: "createNode", id, hasType: SECTION_TYPE },
      { op: "addEdge", from: id, predicate: TEXT, to: text },
      { op: "addEdge", from: id, predicate: ORDER_KEY, to: target.orderKey },
      { op: "addEdge", from: nodeId, predicate: HAS_PART, to: id },
      { op: "removeEdge", from: nodeId, predicate: HAS_PART, to: target.id },
    ];
    await this.capture.capture(ops, authoredBy);

    await this.emitBlockOp({
      block_id: id,
      op_type: "update",
      content_delta: text,
      order_key: target.orderKey,
      timestamp: this.timestamp(),
      authored_by: authoredBy,
      node_id: nodeId,
    });

    return { id, text, orderKey: target.orderKey };
  }

  /**
   * A11 block-grain transactional apply — ONE capture batch (atomic at the
   * substrate), the editor's ops carried as-is. Per-op substrate semantics:
   */
  async applySectionOps(
    nodeId: string,
    ops: SectionOp[],
    authoredBy: AuthoredBy = "human",
  ): Promise<ApplySectionOpsResult> {
    const referenced = ops.flatMap((op) =>
      op.op === "add" ? [] : [op.sectionId],
    );
    if (new Set(referenced).size !== referenced.length) {
      throw new Error(
        `applySectionOps: duplicate section id in batch for node ${nodeId}.`,
      );
    }
    const current = await this.readBody(nodeId);
    const byId = new Map(current.map((s) => [s.id, s]));
    for (const id of referenced) {
      if (!byId.has(id)) {
        throw new Error(
          `stale_section: section ${id} is not part of node ${nodeId}.`,
        );
      }
    }

    const uops: UraniaOp[] = [];
    const applied: AppliedOp[] = [];
    const blockOps: BlockOp[] = [];
    const ts = this.timestamp();
    let post = [...current];

    for (const op of ops) {
      if (op.op === "add") {
        const id = this.capture.mintSectionId(nodeId);
        uops.push({ op: "createNode", id, hasType: SECTION_TYPE });
        uops.push({ op: "addEdge", from: id, predicate: TEXT, to: op.text });
        uops.push({
          op: "addEdge",
          from: id,
          predicate: ORDER_KEY,
          to: op.orderKey,
        });
        uops.push({ op: "addEdge", from: nodeId, predicate: HAS_PART, to: id });
        post.push({ id, text: op.text, orderKey: op.orderKey });
        applied.push({ id, orderKey: op.orderKey });
        blockOps.push({
          block_id: id,
          op_type: "add",
          content_delta: op.text,
          order_key: op.orderKey,
          timestamp: ts,
          authored_by: authoredBy,
          node_id: nodeId,
        });
        continue;
      }
      const target = byId.get(op.sectionId);
      if (target === undefined) {
        throw new Error(
          `stale_section: section ${op.sectionId} vanished mid-batch.`,
        );
      }
      if (op.op === "update") {
        const id = this.capture.mintSectionId(nodeId);
        const orderKey = op.orderKey ?? target.orderKey;
        uops.push({ op: "createNode", id, hasType: SECTION_TYPE });
        uops.push({ op: "addEdge", from: id, predicate: TEXT, to: op.text });
        uops.push({
          op: "addEdge",
          from: id,
          predicate: ORDER_KEY,
          to: orderKey,
        });
        uops.push({ op: "addEdge", from: nodeId, predicate: HAS_PART, to: id });
        uops.push({
          op: "removeEdge",
          from: nodeId,
          predicate: HAS_PART,
          to: target.id,
        });
        post = post.map((s) =>
          s.id === target.id ? { id, text: op.text, orderKey } : s,
        );
        applied.push({ id, orderKey });
        blockOps.push({
          block_id: id,
          op_type: "update",
          content_delta: op.text,
          order_key: orderKey,
          timestamp: ts,
          authored_by: authoredBy,
          node_id: nodeId,
        });
      } else if (op.op === "delete") {
        uops.push({
          op: "removeEdge",
          from: nodeId,
          predicate: HAS_PART,
          to: target.id,
        });
        post = post.filter((s) => s.id !== target.id);
        applied.push({ id: target.id, orderKey: target.orderKey });
        blockOps.push({
          block_id: target.id,
          op_type: "delete",
          content_delta: "",
          order_key: target.orderKey,
          timestamp: ts,
          authored_by: authoredBy,
          node_id: nodeId,
        });
      } else {
        uops.push({
          op: "removeEdge",
          from: target.id,
          predicate: ORDER_KEY,
          to: target.orderKey,
        });
        uops.push({
          op: "addEdge",
          from: target.id,
          predicate: ORDER_KEY,
          to: op.orderKey,
        });
        post = post.map((s) =>
          s.id === target.id ? { ...s, orderKey: op.orderKey } : s,
        );
        applied.push({ id: target.id, orderKey: op.orderKey });
        blockOps.push({
          block_id: target.id,
          op_type: "reorder",
          content_delta: "",
          order_key: op.orderKey,
          timestamp: ts,
          authored_by: authoredBy,
          node_id: nodeId,
        });
      }
    }

    await this.capture.capture(uops, authoredBy);
    for (const blockOp of blockOps) {
      await this.emitBlockOp(blockOp);
    }

    post.sort((a, b) => compareKeys(a.orderKey, b.orderKey));
    return { sections: post, applied };
  }

  readRevisions(): Promise<RevisionMeta[]> {
    return Promise.reject(
      new Error(
        "read_body_revisions: the configured body backend does not support " +
          "revision reads (no readRevisions method).",
      ),
    );
  }

  readRevisionAt(): Promise<Section[]> {
    return Promise.reject(
      new Error(
        "read_body_at: the configured body backend does not support " +
          "revision reads (no readRevisionAt method).",
      ),
    );
  }

  hasBody(): Promise<Map<string, number>> {
    return Promise.reject(
      new Error(
        "has_body: the configured body backend does not support " +
          "prose-presence (no hasBody method).",
      ),
    );
  }
}
