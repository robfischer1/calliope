import {
  type ChaosDial,
  type ChaosOp,
  type NodeEdge,
  type PlacedEdge,
  opAdd,
  opCreate,
  opRemove,
} from "./chaos-client.js";
import { type BlockFact, factsFromEdges } from "./slot-facts.js";

/** container → slot membership. */
export const TREE_MEMBER = "tree_member";
/** slot → fractional order key (opaque scalar, ordered bytewise). */
export const TREE_POSITION = "tree_position";
/** slot → blob reference (the F2 blob domain — never a literal). */
export const TREE_CONTENT = "tree_content";
/** placement slot → origin slot (node domain): transclusion. A slot holds
 *  EXACTLY ONE of `tree_content` or `tree_ref`. Reads resolve a placement
 *  through its origin's current blob (one hop, never a chain); an edit
 *  through a placement rewrites the origin. See transclusion.ts. */
export const TREE_REF = "tree_ref";
/** The slot node's kind — declared in chaos's closed kind set (F3). */
export const BLOCK_KIND = "Block";

/**
 * Birth one slot: mint the Block node and attach all three facts, in one
 * batch, plus any `factOps` (the slot's metadata, built by slot-facts.ts
 * against the same `slotLabel`). `slotLabel` is the batch-local mint reference (themis resolves a
 * non-empty createNode label for later ops in the same batch) — the caller
 * keeps labels unique within a batch, e.g. `b:<position>`.
 */
export function slotBirthOps(
  containerToken: string,
  slotLabel: string,
  position: string,
  blobId: string,
  factOps: ChaosOp[] = [],
): ChaosOp[] {
  return [
    opCreate(BLOCK_KIND, slotLabel),
    opAdd(containerToken, TREE_MEMBER, { toNode: slotLabel }),
    opAdd(slotLabel, TREE_POSITION, { toLiteral: position }),
    opAdd(slotLabel, TREE_CONTENT, { toBlob: blobId }),
    ...factOps,
  ];
}

/**
 * Birth one PLACEMENT slot: like {@link slotBirthOps}, but the slot holds a
 * reference to `originSlot` instead of a blob. One batch, one transaction.
 */
export function placementBirthOps(
  containerToken: string,
  slotLabel: string,
  position: string,
  originSlot: string,
): ChaosOp[] {
  return [
    opCreate(BLOCK_KIND, slotLabel),
    opAdd(containerToken, TREE_MEMBER, { toNode: slotLabel }),
    opAdd(slotLabel, TREE_POSITION, { toLiteral: position }),
    opAdd(slotLabel, TREE_REF, { toNode: originSlot }),
  ];
}

/** Retract a placement's three facts (membership, position, reference), each
 *  in the graphs `held` names for it ({@link placementHeldGraphs}). The origin
 *  is untouched. */
export function placementRemoveOps(
  slotToken: string,
  containerToken: string,
  position: string,
  originSlot: string,
  held: PlacementHeldIn = PLACEMENT_OWN_SCOPE,
): ChaosOp[] {
  return [
    ...held.member.map((g) =>
      opRemove(containerToken, TREE_MEMBER, { toNode: slotToken }, g),
    ),
    ...held.position.map((g) =>
      opRemove(slotToken, TREE_POSITION, { toLiteral: position }, g),
    ),
    ...held.ref.map((g) =>
      opRemove(slotToken, TREE_REF, { toNode: originSlot }, g),
    ),
  ];
}

/** Repoint a slot's content: the edit. Touches ONLY the content fact. The
 *  old fact is retracted in each of `heldIn` (the graphs it is held in, as
 *  {@link heldGraphs} reads them); `undefined` is the batch's own scope. */
export function repointOps(
  slotToken: string,
  oldBlobId: string,
  newBlobId: string,
  heldIn: HeldIn = OWN_SCOPE,
): ChaosOp[] {
  return [
    ...heldIn.map((g) =>
      opRemove(slotToken, TREE_CONTENT, { toBlob: oldBlobId }, g),
    ),
    opAdd(slotToken, TREE_CONTENT, { toBlob: newBlobId }),
  ];
}

/** The graphs a retraction pins to; `undefined` is the batch's own scope. */
export type HeldIn = readonly (string | undefined)[];

const OWN_SCOPE: HeldIn = [undefined];

function graphsHolding(
  edges: readonly PlacedEdge[],
  predicate: string,
  domain: PlacedEdge["domain"],
  value: string,
): HeldIn {
  const graphs = new Set<string | undefined>();
  for (const e of edges) {
    if (e.predicate === predicate && e.domain === domain && e.value === value) {
      graphs.add(e.graph === "" ? undefined : e.graph);
    }
  }
  return graphs.size === 0 ? OWN_SCOPE : [...graphs];
}

/** The graphs `slot`'s `tree_content` → `blobId` fact is held in, for a
 *  retraction to pin to. A dial that cannot say, a fact the door placed in no
 *  named scope, or a fact not held at all answers the batch's own scope. */
export async function heldGraphs(
  dial: ChaosDial,
  slot: string,
  blobId: string,
): Promise<HeldIn> {
  if (dial.placedEdges === undefined) return OWN_SCOPE;
  return graphsHolding(
    await dial.placedEdges(slot),
    TREE_CONTENT,
    "blob",
    blobId,
  );
}

/** Where each of a slot's three tree facts is held. */
export interface SlotHeldIn {
  member: HeldIn;
  position: HeldIn;
  content: HeldIn;
}

const SLOT_OWN_SCOPE: SlotHeldIn = {
  member: OWN_SCOPE,
  position: OWN_SCOPE,
  content: OWN_SCOPE,
};

/** {@link heldGraphs} for all three of a slot's tree facts: its membership
 *  in `containerToken`, its `position` and its content `blobId`. */
export async function slotHeldGraphs(
  dial: ChaosDial,
  slotToken: string,
  containerToken: string,
  position: string,
  blobId: string,
): Promise<SlotHeldIn> {
  if (dial.placedEdges === undefined) return SLOT_OWN_SCOPE;
  const own = await dial.placedEdges(slotToken);
  const box = await dial.placedEdges(containerToken);
  return {
    member: graphsHolding(box, TREE_MEMBER, "node", slotToken),
    position: graphsHolding(own, TREE_POSITION, "scalar", position),
    content: graphsHolding(own, TREE_CONTENT, "blob", blobId),
  };
}

/** Where each of a placement's three tree facts is held. */
export interface PlacementHeldIn {
  member: HeldIn;
  position: HeldIn;
  ref: HeldIn;
}

const PLACEMENT_OWN_SCOPE: PlacementHeldIn = {
  member: OWN_SCOPE,
  position: OWN_SCOPE,
  ref: OWN_SCOPE,
};

/** {@link heldGraphs} for a placement's membership in `containerToken`, its
 *  `position` and its `tree_ref` to `originSlot`. */
export async function placementHeldGraphs(
  dial: ChaosDial,
  slotToken: string,
  containerToken: string,
  position: string,
  originSlot: string,
): Promise<PlacementHeldIn> {
  if (dial.placedEdges === undefined) return PLACEMENT_OWN_SCOPE;
  const own = await dial.placedEdges(slotToken);
  const box = await dial.placedEdges(containerToken);
  return {
    member: graphsHolding(box, TREE_MEMBER, "node", slotToken),
    position: graphsHolding(own, TREE_POSITION, "scalar", position),
    ref: graphsHolding(own, TREE_REF, "node", originSlot),
  };
}

/** Reposition a slot: the reorder. Touches ONLY the position fact. */
export function repositionOps(
  slotToken: string,
  oldPosition: string,
  newPosition: string,
): ChaosOp[] {
  return [
    opRemove(slotToken, TREE_POSITION, { toLiteral: oldPosition }),
    opAdd(slotToken, TREE_POSITION, { toLiteral: newPosition }),
  ];
}

/** Move a slot between containers. Blob and position untouched. */
export function moveOps(
  slotToken: string,
  fromContainerToken: string,
  toContainerToken: string,
): ChaosOp[] {
  return [
    opRemove(fromContainerToken, TREE_MEMBER, { toNode: slotToken }),
    opAdd(toContainerToken, TREE_MEMBER, { toNode: slotToken }),
  ];
}

/** Retract a slot's three facts, each in the graphs `held` names for it
 *  ({@link slotHeldGraphs}). (Tombstoning the node itself is F4's writer
 *  concern; the facts are what structure reads consult.) */
export function slotRemoveOps(
  slotToken: string,
  containerToken: string,
  position: string,
  blobId: string,
  held: SlotHeldIn = SLOT_OWN_SCOPE,
): ChaosOp[] {
  return [
    ...held.member.map((g) =>
      opRemove(containerToken, TREE_MEMBER, { toNode: slotToken }, g),
    ),
    ...held.position.map((g) =>
      opRemove(slotToken, TREE_POSITION, { toLiteral: position }, g),
    ),
    ...held.content.map((g) =>
      opRemove(slotToken, TREE_CONTENT, { toBlob: blobId }, g),
    ),
  ];
}

/** One resolved tree slot. */
export interface TreeSlot {
  slot: string;
  position: string;
  /** The blob id (decimal), or null when the slot has no content fact —
   *  a DANGLING slot, surfaced and never skipped. Raw: a placement's own
   *  blobId is null until {@link resolvePlacements} fills it. */
  blobId: string | null;
  /** The origin slot, when this slot is a placement (`tree_ref`). */
  ref?: string;
  /** The slot's metadata facts — present only when the read asked. */
  facts?: BlockFact[];
}

function firstOf(
  edges: NodeEdge[],
  predicate: string,
  domain: NodeEdge["domain"],
): string | null {
  for (const e of edges) {
    if (e.predicate === predicate && e.domain === domain) return e.value;
  }
  return null;
}

/** The optional `ref` member, spread only when the slot is a placement so a
 *  blob slot's shape is byte-identical to before transclusion. */
export function refOf(origin: string | null | undefined): { ref?: string } {
  return origin === null || origin === undefined ? {} : { ref: origin };
}

/**
 * Resolve a container to its slots in position order (bytewise, matching
 * the sovereign store's COLLATE "C" convention). A slot missing its
 * position sorts last (its slot token breaks the tie deterministically);
 * a slot missing its content reads as dangling (`blobId: null`).
 */
export async function readTree(
  dial: ChaosDial,
  containerToken: string,
  opts?: { facts?: boolean },
): Promise<TreeSlot[]> {
  const memberEdges = await dial.edges(containerToken);
  const slots = memberEdges
    .filter((e) => e.predicate === TREE_MEMBER && e.domain === "node")
    .map((e) => e.value);
  const out: TreeSlot[] = [];
  for (const slot of slots) {
    const edges = await dial.edges(slot);
    out.push({
      slot,
      position: firstOf(edges, TREE_POSITION, "scalar") ?? "￿" + slot,
      blobId: firstOf(edges, TREE_CONTENT, "blob"),
      ...refOf(firstOf(edges, TREE_REF, "node")),
      ...(opts?.facts === true ? { facts: factsFromEdges(edges) } : {}),
    });
  }
  out.sort((a, b) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
  );
  return out;
}
