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
}
