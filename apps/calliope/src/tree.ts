/**
 * The tree (spec 040, master-plan F3) — the graph vocabulary that makes a
 * document a document instead of a bag of rows that remember their owner.
 *
 * A container (an existing graph node — a note, a plan) holds ordered
 * members. Each member is a SLOT: a node of kind `Block` carrying exactly
 * three facts in the container's tenant graph —
 *
 *   (container) --tree_member-->   (slot)
 *   (slot)      --tree_position--> "a0"          fractional key, bytewise order
 *   (slot)      --tree_content-->  blob #17      the F2 blob domain
 *
 * The slot is the durable identity: editing a block repoints its slot at a
 * new blob (the blob never changes — F1's immutability), reordering rewrites
 * its position fact, moving it re-homes its membership fact. `container +
 * position` is the durable address because there is nothing else to key on.
 *
 * This module is vocabulary + op-builders + the ordered read. The write
 * path that composes builders into saves is F4; the history read is F5.
 */

import {
  type ChaosDial,
  type ChaosOp,
  type NodeEdge,
  opAdd,
  opCreate,
  opRemove,
} from "./chaos-client.js";

// ── the vocabulary (the fan-out contract — five tenants read these) ──────────

/** container → slot membership. */
export const TREE_MEMBER = "tree_member";
/** slot → fractional order key (opaque scalar, ordered bytewise). */
export const TREE_POSITION = "tree_position";
/** slot → blob reference (the F2 blob domain — never a literal). */
export const TREE_CONTENT = "tree_content";
/** The slot node's kind — declared in chaos's closed kind set (F3). */
export const BLOCK_KIND = "Block";

// ── op builders (each group is ONE admit batch — one graph transaction) ──────

/**
 * Birth one slot: mint the Block node and attach all three facts, in one
 * batch. `slotLabel` is the batch-local mint reference (themis resolves a
 * non-empty createNode label for later ops in the same batch) — the caller
 * keeps labels unique within a batch, e.g. `b:<position>`.
 */
export function slotBirthOps(
  containerToken: string,
  slotLabel: string,
  position: string,
  blobId: string,
): ChaosOp[] {
  return [
    opCreate(BLOCK_KIND, slotLabel),
    opAdd(containerToken, TREE_MEMBER, { toNode: slotLabel }),
    opAdd(slotLabel, TREE_POSITION, { toLiteral: position }),
    opAdd(slotLabel, TREE_CONTENT, { toBlob: blobId }),
  ];
}

/** Repoint a slot's content: the edit. Touches ONLY the content fact. */
export function repointOps(
  slotToken: string,
  oldBlobId: string,
  newBlobId: string,
): ChaosOp[] {
  return [
    opRemove(slotToken, TREE_CONTENT, { toBlob: oldBlobId }),
    opAdd(slotToken, TREE_CONTENT, { toBlob: newBlobId }),
  ];
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

/** Retract a slot's three facts. (Tombstoning the node itself is F4's
 *  writer concern; the facts are what structure reads consult.) */
export function slotRemoveOps(
  slotToken: string,
  containerToken: string,
  position: string,
  blobId: string,
): ChaosOp[] {
  return [
    opRemove(containerToken, TREE_MEMBER, { toNode: slotToken }),
    opRemove(slotToken, TREE_POSITION, { toLiteral: position }),
    opRemove(slotToken, TREE_CONTENT, { toBlob: blobId }),
  ];
}

// ── the ordered read ─────────────────────────────────────────────────────────

/** One resolved tree slot. */
export interface TreeSlot {
  slot: string;
  position: string;
  /** The blob id (decimal), or null when the slot has no content fact —
   *  a DANGLING slot, surfaced and never skipped. */
  blobId: string | null;
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

/**
 * Resolve a container to its slots in position order (bytewise, matching
 * the sovereign store's COLLATE "C" convention). A slot missing its
 * position sorts last (its slot token breaks the tie deterministically);
 * a slot missing its content reads as dangling (`blobId: null`).
 */
export async function readTree(
  dial: ChaosDial,
  containerToken: string,
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
    });
  }
  out.sort((a, b) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
  );
  return out;
}
