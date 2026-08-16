/**
 * The container read and history (spec 042, master-plan F5).
 *
 * A container read resolves the tree, then fetches its prose in ONE
 * batched blob lookup. History stops being a feature with its own tables:
 * the graph stamped every save with a transaction, so the listing is the
 * door's `history` verb and any past state is the same tree read as-of an
 * earlier transaction. A tree fact naming an absent blob surfaces as
 * DANGLING — reported, never skipped, never fabricated.
 */

import type { ProseStore } from "./blob-store.js";
import {
  type ChaosDial,
  type HistoryEntry,
  scopeHash,
} from "./chaos-client.js";
import type { ContainerFacet } from "./container-write.js";
import { TREE_CONTENT, TREE_MEMBER, TREE_POSITION, readTree } from "./tree.js";

/** One assembled block. */
export interface ContainerBlock {
  slot: string;
  position: string;
  blobId: string | null;
  /** The prose, or null when dangling (blob absent or content fact missing). */
  text: string | null;
  dangling: boolean;
}

export interface ContainerReadResult {
  blocks: ContainerBlock[];
  /** Echoed when this was an as-of read. */
  asOfTx?: number;
}

/** Assemble slots+blobs into ordered blocks with dangling surfaced. */
async function assemble(
  blobs: ProseStore,
  slots: { slot: string; position: string; blobId: string | null }[],
): Promise<ContainerBlock[]> {
  const ids = slots
    .map((s) => s.blobId)
    .filter((id): id is string => id !== null);
  const texts = await blobs.getTexts(ids); // ONE round trip [MP: batch]
  return slots.map((s) => {
    const text = s.blobId !== null ? (texts.get(s.blobId) ?? null) : null;
    return {
      slot: s.slot,
      position: s.position,
      blobId: s.blobId,
      text,
      dangling: text === null,
    };
  });
}

/** The as-of tree resolution: quads at a past transaction, positions
 *  resolved back to values. Members later removed are PRESENT here —
 *  that is the point. */
async function treeAt(
  dial: ChaosDial,
  containerToken: string,
  asOfTx: number,
): Promise<{ slot: string; position: string; blobId: string | null }[]> {
  const memberRows = await dial.quadsFrom([containerToken], asOfTx, [
    TREE_MEMBER,
  ]);
  const slots = memberRows
    .map((r) => r.o)
    .filter((o) => !o.startsWith("blob:"));
  if (slots.length === 0) return [];
  const slotRows = await dial.quadsFrom(slots, asOfTx, [
    TREE_POSITION,
    TREE_CONTENT,
  ]);
  const positionHash = scopeHash(TREE_POSITION);
  const contentHash = scopeHash(TREE_CONTENT);
  const posHashes: string[] = [];
  const perSlot = new Map<string, { positionHash?: string; blobId?: string }>();
  for (const row of slotRows) {
    const cell = perSlot.get(row.s) ?? {};
    if (row.p === positionHash && !row.o.startsWith("blob:")) {
      cell.positionHash = row.o;
      posHashes.push(row.o);
    } else if (row.p === contentHash && row.o.startsWith("blob:")) {
      cell.blobId = row.o.slice("blob:".length);
    }
    perSlot.set(row.s, cell);
  }
  const values = await dial.resolveScalars(posHashes);
  const out = slots.map((slot) => {
    const cell = perSlot.get(slot) ?? {};
    const position =
      cell.positionHash !== undefined
        ? (values[cell.positionHash] ?? "￿" + slot)
        : "￿" + slot;
    return { slot, position, blobId: cell.blobId ?? null };
  });
  out.sort((a, b) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
  );
  return out;
}

/**
 * Read a container — at HEAD (cheap two-hop edges read) or as-of a past
 * transaction (quads + scalar resolution). Either way: one batched blob
 * fetch, ordered blocks, dangling surfaced.
 */
export async function readContainer(
  facet: ContainerFacet,
  containerToken: string,
  opts?: { asOfTx?: number },
): Promise<ContainerReadResult> {
  const slots =
    opts?.asOfTx === undefined
      ? await readTree(facet.dial, containerToken)
      : await treeAt(facet.dial, containerToken, opts.asOfTx);
  const blocks = await assemble(facet.blobs, slots);
  return opts?.asOfTx === undefined
    ? { blocks }
    : { blocks, asOfTx: opts.asOfTx };
}

/**
 * The container's history: every transaction that touched it or any slot
 * it EVER held (the door's log-closure over tree_member), ascending, with
 * authors. No revision table is consulted — the graph is the only source.
 */
export function containerHistory(
  facet: ContainerFacet,
  containerToken: string,
): Promise<HistoryEntry[]> {
  return facet.dial.history([containerToken], [TREE_MEMBER]);
}
