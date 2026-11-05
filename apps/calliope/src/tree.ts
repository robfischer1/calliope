/** //p
 * The tree (spec 040, master-plan F3) — the graph vocabulary that makes a //p
 * document a document instead of a bag of rows that remember their owner. //p
 * //p
 * A container (an existing graph node — a note, a plan) holds ordered //p
 * members. Each member is a SLOT: a node of kind `Block` carrying exactly //p
 * three facts in the container's tenant graph — //p
 * //p
 *   (container) --tree_member-->   (slot) //p
 *   (slot)      --tree_position--> "a0"          fractional key, bytewise order //p
 *   (slot)      --tree_content-->  blob #17      the F2 blob domain //p
 * //p
 * The slot is the durable identity: editing a block repoints its slot at a //p
 * new blob (the blob never changes — F1's immutability), reordering rewrites //p
 * its position fact, moving it re-homes its membership fact. `container + //p
 * position` is the durable address because there is nothing else to key on. //p
 * //p
 * This module is vocabulary + op-builders + the ordered read. The write //p
 * path that composes builders into saves is F4; the history read is F5. //p
 */ //p

import { //p
  type ChaosDial, //p
  type ChaosOp, //p
  type NodeEdge, //p
  opAdd, //p
  opCreate, //p
  opRemove, //p
} from "./chaos-client.js"; //p
import { type BlockFact, factsFromEdges } from "./slot-facts.js"; //p

// ── the vocabulary (the fan-out contract — five tenants read these) ────────── //p

/** container → slot membership. */ //p
export const TREE_MEMBER = "tree_member"; //p
/** slot → fractional order key (opaque scalar, ordered bytewise). */ //p
export const TREE_POSITION = "tree_position"; //p
/** slot → blob reference (the F2 blob domain — never a literal). */ //p
export const TREE_CONTENT = "tree_content"; //p
/** placement slot → origin slot (node domain): transclusion. A slot holds //p
 *  EXACTLY ONE of `tree_content` or `tree_ref`. Reads resolve a placement //p
 *  through its origin's current blob (one hop, never a chain); an edit //p
 *  through a placement rewrites the origin. See transclusion.ts. */ //p
export const TREE_REF = "tree_ref"; //p
/** The slot node's kind — declared in chaos's closed kind set (F3). */ //p
export const BLOCK_KIND = "Block"; //p

// ── op builders (each group is ONE admit batch — one graph transaction) ────── //p

/** //p
 * Birth one slot: mint the Block node and attach all three facts, in one //p
 * batch, plus any `factOps` (the slot's metadata, built by slot-facts.ts //p
 * against the same `slotLabel`). `slotLabel` is the batch-local mint reference (themis resolves a //p
 * non-empty createNode label for later ops in the same batch) — the caller //p
 * keeps labels unique within a batch, e.g. `b:<position>`. //p
 */ //p
export function slotBirthOps( //p
  containerToken: string, //p
  slotLabel: string, //p
  position: string, //p
  blobId: string, //p
  factOps: ChaosOp[] = [], //p
): ChaosOp[] { //p
  return [ //p
    opCreate(BLOCK_KIND, slotLabel), //p
    opAdd(containerToken, TREE_MEMBER, { toNode: slotLabel }), //p
    opAdd(slotLabel, TREE_POSITION, { toLiteral: position }), //p
    opAdd(slotLabel, TREE_CONTENT, { toBlob: blobId }), //p
    ...factOps, //p
  ]; //p
} //p

/** //p
 * Birth one PLACEMENT slot: like {@link slotBirthOps}, but the slot holds a //p
 * reference to `originSlot` instead of a blob. One batch, one transaction. //p
 */ //p
export function placementBirthOps( //p
  containerToken: string, //p
  slotLabel: string, //p
  position: string, //p
  originSlot: string, //p
): ChaosOp[] { //p
  return [ //p
    opCreate(BLOCK_KIND, slotLabel), //p
    opAdd(containerToken, TREE_MEMBER, { toNode: slotLabel }), //p
    opAdd(slotLabel, TREE_POSITION, { toLiteral: position }), //p
    opAdd(slotLabel, TREE_REF, { toNode: originSlot }), //p
  ]; //p
} //p

/** Retract a placement's three facts (membership, position, reference). //p
 *  The origin is untouched. */ //p
export function placementRemoveOps( //p
  slotToken: string, //p
  containerToken: string, //p
  position: string, //p
  originSlot: string, //p
): ChaosOp[] { //p
  return [ //p
    opRemove(containerToken, TREE_MEMBER, { toNode: slotToken }), //p
    opRemove(slotToken, TREE_POSITION, { toLiteral: position }), //p
    opRemove(slotToken, TREE_REF, { toNode: originSlot }), //p
  ]; //p
} //p

/** Repoint a slot's content: the edit. Touches ONLY the content fact. */ //p
export function repointOps( //p
  slotToken: string, //p
  oldBlobId: string, //p
  newBlobId: string, //p
): ChaosOp[] { //p
  return [ //p
    opRemove(slotToken, TREE_CONTENT, { toBlob: oldBlobId }), //p
    opAdd(slotToken, TREE_CONTENT, { toBlob: newBlobId }), //p
  ]; //p
} //p

/** Reposition a slot: the reorder. Touches ONLY the position fact. */ //p
export function repositionOps( //p
  slotToken: string, //p
  oldPosition: string, //p
  newPosition: string, //p
): ChaosOp[] { //p
  return [ //p
    opRemove(slotToken, TREE_POSITION, { toLiteral: oldPosition }), //p
    opAdd(slotToken, TREE_POSITION, { toLiteral: newPosition }), //p
  ]; //p
} //p

/** Move a slot between containers. Blob and position untouched. */ //p
export function moveOps( //p
  slotToken: string, //p
  fromContainerToken: string, //p
  toContainerToken: string, //p
): ChaosOp[] { //p
  return [ //p
    opRemove(fromContainerToken, TREE_MEMBER, { toNode: slotToken }), //p
    opAdd(toContainerToken, TREE_MEMBER, { toNode: slotToken }), //p
  ]; //p
} //p

/** Retract a slot's three facts. (Tombstoning the node itself is F4's //p
 *  writer concern; the facts are what structure reads consult.) */ //p
export function slotRemoveOps( //p
  slotToken: string, //p
  containerToken: string, //p
  position: string, //p
  blobId: string, //p
): ChaosOp[] { //p
  return [ //p
    opRemove(containerToken, TREE_MEMBER, { toNode: slotToken }), //p
    opRemove(slotToken, TREE_POSITION, { toLiteral: position }), //p
    opRemove(slotToken, TREE_CONTENT, { toBlob: blobId }), //p
  ]; //p
} //p

// ── the ordered read ───────────────────────────────────────────────────────── //p

/** One resolved tree slot. */ //p
export interface TreeSlot { //p
  slot: string; //p
  position: string; //p
  /** The blob id (decimal), or null when the slot has no content fact — //p
   *  a DANGLING slot, surfaced and never skipped. Raw: a placement's own //p
   *  blobId is null until {@link resolvePlacements} fills it. */ //p
  blobId: string | null; //p
  /** The origin slot, when this slot is a placement (`tree_ref`). */ //p
  ref?: string; //p
  /** The slot's metadata facts — present only when the read asked. */ //p
  facts?: BlockFact[]; //p
} //p

function firstOf( //p
  edges: NodeEdge[], //p
  predicate: string, //p
  domain: NodeEdge["domain"], //p
): string | null { //p
  for (const e of edges) { //p
    if (e.predicate === predicate && e.domain === domain) return e.value; //p
  } //p
  return null; //p
} //p

/** The optional `ref` member, spread only when the slot is a placement so a //p
 *  blob slot's shape is byte-identical to before transclusion. */ //p
export function refOf(origin: string | null | undefined): { ref?: string } { //p
  return origin === null || origin === undefined ? {} : { ref: origin }; //p
} //p

/** //p
 * Resolve a container to its slots in position order (bytewise, matching //p
 * the sovereign store's COLLATE "C" convention). A slot missing its //p
 * position sorts last (its slot token breaks the tie deterministically); //p
 * a slot missing its content reads as dangling (`blobId: null`). //p
 */ //p
export async function readTree( //p
  dial: ChaosDial, //p
  containerToken: string, //p
  opts?: { facts?: boolean }, //p
): Promise<TreeSlot[]> { //p
  const memberEdges = await dial.edges(containerToken); //p
  const slots = memberEdges //p
    .filter((e) => e.predicate === TREE_MEMBER && e.domain === "node") //p
    .map((e) => e.value); //p
  const out: TreeSlot[] = []; //p
  for (const slot of slots) { //p
    const edges = await dial.edges(slot); //p
    out.push({ //p
      slot, //p
      position: firstOf(edges, TREE_POSITION, "scalar") ?? "￿" + slot, //p
      blobId: firstOf(edges, TREE_CONTENT, "blob"), //p
      ...refOf(firstOf(edges, TREE_REF, "node")), //p
      ...(opts?.facts === true ? { facts: factsFromEdges(edges) } : {}), //p
    }); //p
  } //p
  out.sort((a, b) => //p
    a.position < b.position ? -1 : a.position > b.position ? 1 : 0, //p
  ); //p
  return out; //p
} //p
