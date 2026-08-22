/**
 * The container-backed note body (047 F12 follow-up — calliope#5290).
 *
 * After the cut, the tree + blob store are the ONLY home a note's prose has:
 * the `sections` table is dropped, so a {@link BodyClient} that still reads
 * it (the pg body client) answers `relation "sections" does not exist` on
 * every fleet call that reaches it. Measured 2026-08-22 on the live star:
 * `materialize_note(container_id)` erred for every id while `read_container`
 * on the same id answered the blocks — the tree held the note, only the
 * read path was wrong. The note verbs (dissolve / export / materialize) and
 * the inline-tag reconcile go through THIS adapter: the same tree read
 * `read_container` serves, the same write `write_container` is. Never a
 * table.
 */

import type { Tenant } from "./chaos-client.js";
import type { ContainerBlock } from "./container-read.js";
import { readContainer } from "./container-read.js";
import type { ContainerFacet, ContainerOp } from "./container-write.js";
import { writeContainer } from "./container-write.js";
import { between } from "./order-key.js";
import type { NoteBodies, Section, SectionInput } from "./types.js";

/**
 * Blocks → the wire Section shape: the slot is the id, the position the
 * order key. A dangling block (blob absent) reads as empty prose here —
 * `read_container` reports the dangling flag; a body still has to assemble.
 */
export function sectionsOf(blocks: readonly ContainerBlock[]): Section[] {
  return blocks.map((b) => ({
    id: b.slot,
    text: b.text ?? "",
    orderKey: b.position,
  }));
}

/**
 * The coarse-save diff — reconcile `blocks` (as they stand) to `sections`
 * (as wanted), positionally: the shared prefix updates in place (a
 * byte-identical update nets out inside the write), extras append after the
 * tail, surplus slots are removed. Slot identity survives an edit, which is
 * what keeps a block address (F11's read_block by slot) stable across a
 * save. A dangling surplus slot has no blob to name in a remove op and is
 * left for the census.
 */
export function bodyDiffOps(
  blocks: readonly ContainerBlock[],
  sections: readonly SectionInput[],
): ContainerOp[] {
  const ops: ContainerOp[] = [];
  const shared = Math.min(blocks.length, sections.length);
  for (let i = 0; i < shared; i++) {
    const cur = blocks[i];
    const want = sections[i];
    if (cur === undefined || want === undefined) continue;
    if ((cur.text ?? "") !== want.text) {
      ops.push({
        op: "update",
        slot: cur.slot,
        oldBlobId: cur.blobId ?? "",
        text: want.text,
      });
    }
  }
  let tail = blocks[blocks.length - 1]?.position ?? null;
  for (const extra of sections.slice(shared)) {
    tail = between(tail, null);
    ops.push({ op: "add", text: extra.text, position: tail });
  }
  for (const gone of blocks.slice(shared)) {
    if (gone.blobId === null) continue;
    ops.push({
      op: "remove",
      slot: gone.slot,
      position: gone.position,
      blobId: gone.blobId,
    });
  }
  return ops;
}

/** A container's body as sections — the tree read, wire-shaped. */
export async function readContainerBody(
  facet: ContainerFacet,
  container: string,
): Promise<Section[]> {
  return sectionsOf((await readContainer(facet, container)).blocks);
}

/** Coarse-save a container's body: read the tree, diff, one write. A save
 *  that diffs to nothing opens no transaction. */
export async function saveContainerBody(
  facet: ContainerFacet,
  container: string,
  sections: readonly SectionInput[],
  tenant: Tenant = "notes",
): Promise<void> {
  const { blocks } = await readContainer(facet, container);
  const ops = bodyDiffOps(blocks, sections);
  if (ops.length === 0) return;
  await writeContainer(facet, container, ops, tenant);
}

/**
 * The {@link NoteBodies} surface over a container facet — what the note
 * verbs are handed in place of the body client.
 */
export function containerBodies(
  facet: ContainerFacet,
  tenant: Tenant = "notes",
): NoteBodies {
  return {
    readBody: (nodeId) => readContainerBody(facet, nodeId),
    saveBody: (nodeId, sections) =>
      saveContainerBody(facet, nodeId, sections, tenant),
  };
}
