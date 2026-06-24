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
 * - `authored_by`   — provenance from the write path (`"human"` when the gateway
 *                     auth seam enforces `SET ROLE human`; `"calliope"` otherwise).
 * - `node_id`       — the owning note/node id (the subject of the `hasPart` edge).
 */
export interface BlockOp {
  block_id: string;
  op_type: "add" | "update" | "delete" | "reorder";
  content_delta: string;
  order_key: string;
  timestamp: string;
  authored_by: "human" | "calliope";
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
  saveBody(nodeId: string, sections: SectionInput[]): Promise<void>;

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
   * Optional for backward compatibility: a {@link BodyClient} predating this
   * method (e.g. a host's own adapter) need not implement it; the two clients
   * shipped here ({@link FixtureBodyClient}, {@link UraniaBodyClient}) both do.
   */
  editSection?(
    nodeId: string,
    sectionId: string,
    text: string,
  ): Promise<Section>;
}
