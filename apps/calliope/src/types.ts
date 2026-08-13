/**
 * The public seam between a render surface (e.g. Tantalus) and Calliope.
 *
 * A {@link Section} is the resolved, displayable unit of a node's body. The
 * substrate stores a body as `note --hasPart--> section` node edges, where each
 * `section` carries a `text` literal (the prose, content-addressed by the
 * substrate into the scalar pool) and an `order_key` literal (a fractional sort
 * key). Calliope reads those, sorts by `order_key` (COLLATE "C"), and presents
 * the ordered {@link Section}[] to the editor.
 */
export interface Section {
  /**
   * The section node's placement id. This is a *placement* identity, not a
   * content hash — content-addressing of the prose itself is the substrate's
   * job on the `text` literal. Two sections with identical prose are still two
   * distinct ids.
   */
  id: string;
  /** The section's prose. */
  text: string;
  /** The fractional sort key. Sections render in ascending `order_key`,
   *  compared as raw bytes (COLLATE "C"), never numerically. */
  orderKey: string;
}

/**
 * An incoming section on a coarse save. Position is conveyed by *array order* —
 * the caller hands Calliope the sections in display order and Calliope mints the
 * fractional `order_key` literals. No id and no order key are supplied: a save
 * reconciles the whole body, so the substrate (or {@link FixtureBodyClient})
 * owns identity + ordering.
 */
export interface SectionInput {
  /** The section's prose. */
  text: string;
}

/**
 * A fleet session identity — the SPIFFE form Kairos mints per session and
 * Terpsichore resolves back to a transcript. The tail is the session uuid.
 */
export type SessionPrincipal = `spiffe://${string}/session/${string}`;

/**
 * The provenance identity carried on every body write (024 — widened).
 *
 * - `"human"`    — attributed to Rob; the gateway issues `SET ROLE human` so
 *                  block-ops written to Mnemosyne carry `authored_by = human`.
 * - `"calliope"` — machine-authored (the default for legacy / direct-engine
 *                  writes that predate the gateway auth seam).
 * - a {@link SessionPrincipal} — attributed to a specific agent session
 *   (`spiffe://{td}/session/{uuid}`), resolvable to that session's history.
 *
 * The storage column (`sections.authored_by`) is `text`; only this type and
 * the boundary validation widen. Authenticity of a supplied principal is NOT
 * verified here — form-only validation (the Kairos-vs-gateway trust posture
 * is a surfaced open item of the master plan, not decided in 024).
 */
export type AuthoredBy = "human" | "calliope" | SessionPrincipal;

/**
 * The session-principal grammar: UUID-tailed (lowercase hex), matching what
 * Kairos mints and what Terpsichore can resolve. A looser tail would store a
 * citation no read rung can ever answer.
 */
export const SESSION_PRINCIPAL_RE =
  /^spiffe:\/\/[^/]+\/session\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Runtime guard for the widened union — the MCP boundary's validator. */
export function isAuthoredBy(v: string): v is AuthoredBy {
  return v === "human" || v === "calliope" || SESSION_PRINCIPAL_RE.test(v);
}

/**
 * 026: derive the comment container for a target container. Comments are
 * ordinary blocks that live BESIDE the document, not in it — the target's
 * body reads stay byte-identical however hard a plan gets reviewed. The
 * derivation is idempotent on the suffix so a reply (a comment whose target
 * is a comment) lands beside its parent rather than nesting containers.
 * `#` cannot collide with real node tokens (64-hex / ULID).
 */
export const COMMENT_CONTAINER_SUFFIX = "#comments";

/** See {@link COMMENT_CONTAINER_SUFFIX}. */
export function commentContainerOf(containerId: string): string {
  return containerId.endsWith(COMMENT_CONTAINER_SUFFIX)
    ? containerId
    : containerId + COMMENT_CONTAINER_SUFFIX;
}

/** How a comment's target stands right now (026 — thread resolution). */
export type TargetState = "active" | "superseded" | "deleted";

/** One comment as the thread read returns it (026). */
export interface CommentRecord {
  /** The comment block's section id. */
  id: string;
  /** The comment's prose. */
  text: string;
  /** The commenting session's principal (comments are attributed by definition). */
  author: string;
  /** The session-log position of the write, or null (025 semantics). */
  kafkaOffset: number | null;
  /** ISO-8601 UTC — the comment block's birth (F8's anchor input). */
  createdAt: string;
  /** The block this comment's edge points at (a block, or a parent comment). */
  commentsOn: string;
  /**
   * 027 (present only under `resolveAnchors`): the target's prose as of this
   * comment's creation — the exact text the commenting session was reading
   * (`readRevisionAt` at `createdAt`); null when the target was not in that
   * reconstruction.
   */
  anchorText?: string | null;
  /** 027 (with `resolveAnchors`): the target's current prose, or null. */
  currentText?: string | null;
  /** 027 (with `resolveAnchors`): anchor and current disagree. */
  drift?: boolean;
}

/** One block's thread: the target's current state + its comments (026). */
export interface CommentThread {
  targetId: string;
  targetState: TargetState;
  comments: CommentRecord[];
}

/**
 * 025: the offset⇒session-principal invariant. A log offset names an exact
 * position in ONE session's event log; carried by a non-session write it is
 * a guess about provenance, and a guess poisons every replay that trusts it.
 * Enforced at the MCP boundary (caller-facing error) AND by the store
 * clients (so no internal caller can bypass it).
 */
export function validateWriteProvenance(
  authoredBy?: AuthoredBy,
  kafkaOffset?: number,
): void {
  if (kafkaOffset === undefined) return;
  if (authoredBy === undefined || !SESSION_PRINCIPAL_RE.test(authoredBy)) {
    throw new Error(
      "kafka_offset requires a session-principal authored_by " +
        "(spiffe://{td}/session/{uuid}) on the same call — an offset " +
        "without a session is a guess, and the store refuses to record one.",
    );
  }
}

/**
 * One block-grain write op (A11) — the editor's diff carried as-is through
 * the wire, the store write, the block-op log, and the revision surface.
 *
 * - `add`     — mint a new section with the CALLER's fractional `orderKey`
 *               (client-minted between-neighbors; sibling keys never move).
 * - `update`  — single-section copy-on-write (the `edit_section` semantics):
 *               fresh placement id, `order_key` preserved unless `orderKey`
 *               is supplied (an edit+move in one gesture).
 * - `delete`  — the section leaves the body; its history is preserved.
 * - `reorder` — the section moves to the caller's `orderKey`; prose
 *               unchanged. (Placement identity is backend-defined: the
 *               substrate moves the `order_key` edge in place; the sovereign
 *               store re-places via copy-on-write.)
 *
 * Batch rules: at most ONE op per `sectionId`; any stale `sectionId` rejects
 * the WHOLE batch (`stale_section`) — nothing is applied.
 */
export type SectionOp =
  | { op: "add"; text: string; orderKey: string }
  | { op: "update"; sectionId: string; text: string; orderKey?: string }
  | { op: "delete"; sectionId: string }
  | { op: "reorder"; sectionId: string; orderKey: string };

/** Per-op result, aligned to the ops array: the section's post-apply
 *  placement id + order key (for `delete`, the removed id + last key). */
export interface AppliedOp {
  id: string;
  orderKey: string;
}

/** The {@link BodyClient.applySectionOps} result: the full post-apply body
 *  (sorted) + the per-op alignment. */
export interface ApplySectionOpsResult {
  sections: Section[];
  applied: AppliedOp[];
}

/**
 * The semantic op type emitted into the block-op transaction log (F3).
 *
 * Each editor transaction produces one or more `BlockOp` records that describe
 * WHAT changed at the block level — `add`, `update`, `delete`, or `reorder` —
 * independently of the low-level urania `UraniaOp` stream. These are emitted as
 * an APPEND-ONLY side-channel to Mnemosyne via the clotho `capture` verb; they
 * never replace the `hasPart`/section substrate writes.
 *
 * Field semantics:
 * - `block_id`      — the section's placement id (urania node hex / fixture id).
 * - `op_type`       — the semantic op: `add` (new section), `update` (prose
 *                     changed), `delete` (section removed from body), `reorder`
 *                     (same prose, new position).
 * - `content_delta` — for `add`/`update`: the new prose; for `reorder`/`delete`:
 *                     empty string (the prose itself did not change).
 * - `order_key`     — the fractional sort key at the time of the op (the new
 *                     key for `add`/`reorder`; the last known key for `delete`).
 * - `timestamp`     — ISO-8601 UTC string minted at emission time.
 * - `authored_by`   — provenance from the write path: `"human"` (gateway
 *                     `SET ROLE human` seam), `"calliope"`, or a session
 *                     principal (see {@link AuthoredBy}).
 * - `node_id`       — the owning note/node id (the subject of the `hasPart` edge).
 */
export interface BlockOp {
  block_id: string;
  op_type: "add" | "update" | "delete" | "reorder";
  content_delta: string;
  order_key: string;
  timestamp: string;
  authored_by: AuthoredBy;
  node_id: string;
}

/**
 * Side-channel emitter for the block-op transaction log.
 *
 * The log is APPEND-ONLY: `emit` is called once per block-op and never receives
 * a destructive update. The default no-op implementation is used when no emitter
 * is injected; inject a real one (e.g. a Mnemosyne/clotho capture transport) to
 * persist the log downstream.
 */
export interface BlockOpEmitter {
  /**
   * Emit one block-op record. Implementations may be synchronous or async; the
   * caller awaits the result so back-pressure is respected.
   */
  emit(op: BlockOp): void | Promise<void>;
}

/**
 * The body transport. Two implementations ship:
 *
 * - {@link FixtureBodyClient} — in-memory, fully working; the default for
 *   standalone dev and for Tantalus today.
 * - {@link UraniaBodyClient} — substrate-direct (urania capture via the Hades
 *   gate). The body-model mapping is real; the live wire is deferred behind a
 *   flag, exactly like Tantalus's current clotho swap-seam.
 */
export interface BodyClient {
  /**
   * Resolve a node's body: its `hasPart` section targets, each resolved to
   * `{ text, order_key }`, returned sorted by `orderKey` (COLLATE "C"). A node
   * with no body resolves to `[]`.
   */
  readBody(nodeId: string): Promise<Section[]>;

  /**
   * Coarse-save: reconcile the node's body to `sections` (in display order).
   * The implementation reconciles to the substrate body model — minting
   * fractional `order_key` literals and, for the substrate, copy-on-write
   * versioning of changed prose + rewiring `hasPart`.
   */
  saveBody(
    nodeId: string,
    sections: SectionInput[],
    authoredBy?: AuthoredBy,
    kafkaOffset?: number,
  ): Promise<void>;

  /**
   * Single-section copy-on-write edit: replace the prose of the section
   * `sectionId` under `nodeId` with `text`, leaving every other section and the
   * body order untouched. The section keeps its `order_key`; on the substrate
   * the changed prose mints a fresh version node and `hasPart` is rewired to it
   * (the old node stays as the prior version), exactly as a coarse save does for
   * a changed section.
   *
   * Resolves to the (possibly new) section's resolved {@link Section}. Rejects if
   * `sectionId` is not a current `hasPart` target of `nodeId`.
   *
   * F4: a BYTE-IDENTICAL re-submit is a no-op — the current section returns
   * unchanged (same id), and no row, lineage edge or revision event is
   * written. The comparison is made under the write path's own lock, so a
   * racing real edit is never swallowed. Retrying callers are safe.
   *
   * Optional for backward compatibility: a {@link BodyClient} predating this
   * method (e.g. a host's own adapter) need not implement it; the two clients
   * shipped here ({@link FixtureBodyClient}, {@link UraniaBodyClient}) both do.
   */
  editSection?(
    nodeId: string,
    sectionId: string,
    text: string,
    authoredBy?: AuthoredBy,
    kafkaOffset?: number,
  ): Promise<Section>;

  /**
   * A11 block-grain transactional write: apply the editor's {@link SectionOp}
   * batch — ALL ops or none. Per-op semantics are the {@link editSection}
   * copy-on-write engine generalized (see {@link SectionOp}); an op whose
   * `sectionId` is not a current section rejects the whole batch with a
   * `stale_section` error — the caller's compare-before-write race backstop.
   * One revision event (`kind: "ops"`) and one block-op per applied op.
   *
   * Optional for backward compatibility, like {@link editSection}.
   */
  applySectionOps?(
    nodeId: string,
    ops: SectionOp[],
    authoredBy?: AuthoredBy,
    kafkaOffset?: number,
  ): Promise<ApplySectionOpsResult>;

  /**
   * F3 identity-preserving split: cut the section `sectionId` at `offset`
   * (UTF-16 code units into its `text`, `0 ≤ offset ≤ length` — boundary
   * splits produce an empty-prose child, which is legal). The original is
   * superseded by TWO fresh children: the first keeps the original's
   * `order_key`, the second takes a fractional key strictly between the
   * original and its next active neighbour. BOTH children record the
   * original as lineage predecessor, so anchors resolve forward. One
   * transaction; a stale `sectionId` rejects with `stale_section`.
   *
   * Optional like {@link editSection}; the fs backend deliberately never
   * grows it (file is truth, one block, no inference).
   */
  splitSection?(
    nodeId: string,
    sectionId: string,
    offset: number,
    authoredBy?: AuthoredBy,
    kafkaOffset?: number,
  ): Promise<[Section, Section]>;

  /**
   * F3 identity-preserving merge of two ADJACENT sections: `firstId` must
   * order strictly before `secondId` with no active section between, else
   * the op rejects with `not_adjacent`. Both parents are superseded by ONE
   * survivor carrying `first.text + separator + second.text` (separator
   * default `""`) at the first parent's `order_key`. The survivor records
   * BOTH parents as lineage predecessors (the F1 join table — the op the
   * single-valued `supersedes` column cannot express). One transaction;
   * stale ids reject with `stale_section`.
   */
  mergeSections?(
    nodeId: string,
    firstId: string,
    secondId: string,
    separator?: string,
    authoredBy?: AuthoredBy,
    kafkaOffset?: number,
  ): Promise<Section>;

  /**
   * F8 arc coalescing: collapse the single-link supersession chain ending at
   * the active `blockId` back to (but not past) the arc-start moment
   * `sinceRevision`, physically removing pause-write intermediates and
   * rewiring lineage across the gap. Structural events are boundaries.
   * Optional — the sovereign store implements it; fs and fixture do not.
   */
  coalesceArc?(
    nodeId: string,
    blockId: string,
    sinceRevision: string,
  ): Promise<{ removed: number; from: string; to: string }>;

  /**
   * 026: create a comment — an ordinary block in the target container's
   * comment container ({@link commentContainerOf}) plus one `commentsOn`
   * edge — in ONE transaction (a block without its edge is an invisible
   * orphan; an edge without its block is a dangling pointer; neither may
   * ever be observable). The author MUST be a session principal — comments
   * are attributed by definition (TURN 258) — and the target must be a
   * block of `containerId`'s lineage universe (its body, its history, or
   * its comment container for replies). Optional like {@link editSection}.
   */
  createComment?(
    containerId: string,
    targetBlockId: string,
    text: string,
    authoredBy: AuthoredBy,
    kafkaOffset?: number,
  ): Promise<{
    comment: Section;
    targetId: string;
    commentContainerId: string;
  }>;

  /**
   * 026: read comment threads. With `blockId`: that block's thread,
   * INCLUDING comments made on its lineage predecessors (the supersessions
   * walk — an edit must not orphan its review trail). Without: every thread
   * in the container, keyed by target. Both directions of the edge are
   * answered by this one read (a thread names its target; a comment record
   * names what it comments on).
   */
  listComments?(
    containerId: string,
    blockId?: string,
    resolveAnchors?: boolean,
  ): Promise<CommentThread[]>;

  /**
   * List the body's stored revisions — the write-events of its copy-on-write
   * lineage, newest first. Each coarse save and each single-section edit is
   * one event. Optional for backward compatibility, like {@link editSection}:
   * a transport without it simply has no history surface.
   */
  readRevisions?(nodeId: string, limit?: number): Promise<RevisionMeta[]>;

  /**
   * Findability F10 — bulk prose-presence: active-block counts for every id
   * in `nodeIds` that has a body; ids with none are simply absent from the
   * map. ONE round-trip for a whole extent — the Aglaia browse list's badge
   * was backlogged on per-node read_body never scaling to ~1,400 nodes
   * (footgun #5: never scan a directory's contents to render its structure).
   * Optional: store-backed clients implement it; the fs grain's directory
   * has the local index for this.
   */
  hasBody?(nodeIds: readonly string[]): Promise<Map<string, number>>;

  /**
   * Reconstruct the body as it stood at the write-event `revision` (a value
   * returned by {@link readRevisions}). Resolves to the ordered sections of
   * that moment; a revision predating the body resolves to `[]`.
   */
  readRevisionAt?(nodeId: string, revision: string): Promise<Section[]>;
}

/**
 * One write-event in a body's copy-on-write lineage (the A8 history surface).
 *
 * - `revision`    — the event's identity: its `created_at` as an ISO-8601 UTC
 *                   string (one transaction = one event; rows written together
 *                   share it).
 * - `kind`        — `"save"` (a coarse save minted a fresh generation),
 *                   `"edit"` (a single-section copy-on-write edit), or
 *                   `"ops"` (an A11 block-grain batch).
 * - `authoredBy`  — the provenance persisted with the event's rows.
 * - `kafkaOffset` — the writing session's log offset (025), or null when the
 *                   event carried no session context.
 * - `sections`    — how many section rows the event wrote (a save writes the
 *                   whole body; an edit writes one; an ops batch one per op).
 */
export interface RevisionMeta {
  revision: string;
  kind: "save" | "edit" | "ops";
  authoredBy: string;
  kafkaOffset: number | null;
  sections: number;
}

/**
 * 028 ("Look At This" F5, mirroring theia 058/F3): the focus-pointer
 * payload — discriminated from day one so a shell-level register is a
 * widening, not a rewrite. This is a byte-compatible MIRROR of theia's
 * `packages/aglaia/src/types.ts` BodyPointer; both sides pin the shape with
 * tests, so a divergence goes red on whichever side moved.
 *
 * The body variant carries CAPTURE-TIME-RESOLVED coordinates — a stable
 * section (block) id + UTF-16 offsets into the section's rendered plain
 * text + the resolved excerpt (the drift witness) — never raw editor
 * positions.
 */
export interface BodyPointer {
  kind: "body";
  /** The note/node the pointer addresses (the backend's node id). */
  node: string;
  /** The stable section (block) placement id inside the node's body. */
  section: string;
  /** UTF-16 code-unit offset range into the section's plain text. */
  offsetFrom: number;
  offsetTo: number;
  /** The excerpt as resolved AT CAPTURE — the drift witness. */
  text: string;
  /** ISO-8601 UTC capture moment. */
  ts: string;
}

/** The focus-pointer union — one variant today; widened by adding kinds. */
export type FocusPointer = BodyPointer;

/** Narrow an unknown payload to a {@link BodyPointer}. Unknown kinds and
 *  malformed shapes answer false — tolerated, never thrown. */
export function isBodyPointer(p: unknown): p is BodyPointer {
  if (p === null || typeof p !== "object") return false;
  const c = p as Record<string, unknown>;
  return (
    c.kind === "body" &&
    typeof c.node === "string" &&
    typeof c.section === "string" &&
    typeof c.offsetFrom === "number" &&
    typeof c.offsetTo === "number" &&
    typeof c.text === "string" &&
    typeof c.ts === "string"
  );
}
