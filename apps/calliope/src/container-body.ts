/** //p
 * The container-backed note body (047 F12 follow-up — calliope#5290). //p
 * //p
 * After the cut, the tree + blob store are the ONLY home a note's prose has: //p
 * the `sections` table is dropped, so a {@link BodyClient} that still reads //p
 * it (the pg body client) answers `relation "sections" does not exist` on //p
 * every fleet call that reaches it. Measured 2026-08-22 on the live star: //p
 * `materialize_note(container_id)` erred for every id while `read_container` //p
 * on the same id answered the blocks — the tree held the note, only the //p
 * read path was wrong. The note verbs (dissolve / export / materialize) and //p
 * the inline-tag reconcile go through THIS adapter: the same tree read //p
 * `read_container` serves, the same write `write_container` is. Never a //p
 * table. //p
 */ //p

import type { Tenant } from "./chaos-client.js"; //p
import type { ContainerBlock } from "./container-read.js"; //p
import { readContainer } from "./container-read.js"; //p
import type { ContainerFacet, ContainerOp } from "./container-write.js"; //p
import { writeContainer } from "./container-write.js"; //p
import { mintRun, sequence } from "./order-key.js"; //p
import type { NoteBodies, Section, SectionInput } from "./types.js"; //p

/** //p
 * Blocks → the wire Section shape: the slot is the id, the position the //p
 * order key. A dangling block (blob absent) reads as empty prose here — //p
 * `read_container` reports the dangling flag; a body still has to assemble. //p
 */ //p
export function sectionsOf(blocks: readonly ContainerBlock[]): Section[] { //p
  return blocks.map((b) => ({ //p
    id: b.slot, //p
    text: b.text ?? "", //p
    orderKey: b.position, //p
  })); //p
} //p

/** //p
 * The coarse-save diff — reconcile `blocks` (as they stand) to `sections` //p
 * (as wanted), positionally: the shared prefix updates in place (a //p
 * byte-identical update nets out inside the write), extras append after the //p
 * tail, surplus slots are removed. Slot identity survives an edit, which is //p
 * what keeps a block address (F11's read_block by slot) stable across a //p
 * save. A dangling surplus slot has no blob to name in a remove op and is //p
 * left for the census. //p
 */ //p
export function bodyDiffOps( //p
  blocks: readonly ContainerBlock[], //p
  sections: readonly SectionInput[], //p
): ContainerOp[] { //p
  const ops: ContainerOp[] = []; //p
  const shared = Math.min(blocks.length, sections.length); //p
  for (let i = 0; i < shared; i++) { //p
    const cur = blocks[i]; //p
    const want = sections[i]; //p
    if (cur === undefined || want === undefined) continue; //p
    if ((cur.text ?? "") !== want.text) { //p
      ops.push({ //p
        op: "update", //p
        slot: cur.slot, //p
        oldBlobId: cur.blobId ?? "", //p
        text: want.text, //p
      }); //p
    } //p
  } //p
  const extras = sections.slice(shared); //p
  const tail = blocks[shared - 1]?.position ?? null; //p
  const minted = mintRun(tail, null, extras.length); //p
  let addKeys: string[]; //p
  if (minted !== null) { //p
    addKeys = minted; //p
  } else { //p
    // The appended keys would outgrow the cap (or no key fits): re-lay the //p
    // kept blocks and the new ones with sequence(), in this same write — one //p
    // batch, so no reader sees a half-rebalanced container. //p
    const keys = sequence(shared + extras.length); //p
    for (let i = 0; i < shared; i++) { //p
      const cur = blocks[i]; //p
      const key = keys[i]; //p
      if (cur === undefined || key === undefined || cur.position === key) { //p
        continue; //p
      } //p
      ops.push({ //p
        op: "reorder", //p
        slot: cur.slot, //p
        oldPosition: cur.position, //p
        position: key, //p
        guard: true, //p
      }); //p
    } //p
    addKeys = keys.slice(shared); //p
  } //p
  for (const [i, extra] of extras.entries()) { //p
    ops.push({ op: "add", text: extra.text, position: addKeys[i] ?? "" }); //p
  } //p
  for (const gone of blocks.slice(shared)) { //p
    if (gone.blobId === null) continue; //p
    ops.push({ //p
      op: "remove", //p
      slot: gone.slot, //p
      position: gone.position, //p
      blobId: gone.blobId, //p
    }); //p
  } //p
  return ops; //p
} //p

/** A container's body as sections — the tree read, wire-shaped. */ //p
export async function readContainerBody( //p
  facet: ContainerFacet, //p
  container: string, //p
): Promise<Section[]> { //p
  return sectionsOf((await readContainer(facet, container)).blocks); //p
} //p

/** Coarse-save a container's body: read the tree, diff, one write. A save //p
 *  that diffs to nothing opens no transaction. */ //p
export async function saveContainerBody( //p
  facet: ContainerFacet, //p
  container: string, //p
  sections: readonly SectionInput[], //p
  tenant: Tenant = "notes", //p
): Promise<void> { //p
  const { blocks } = await readContainer(facet, container); //p
  const ops = bodyDiffOps(blocks, sections); //p
  if (ops.length === 0) return; //p
  await writeContainer(facet, container, ops, tenant); //p
} //p

/** //p
 * The {@link NoteBodies} surface over a container facet — what the note //p
 * verbs are handed in place of the body client. //p
 */ //p
export function containerBodies( //p
  facet: ContainerFacet, //p
  tenant: Tenant = "notes", //p
): NoteBodies { //p
  return { //p
    readBody: (nodeId) => readContainerBody(facet, nodeId), //p
    saveBody: (nodeId, sections) => //p
      saveContainerBody(facet, nodeId, sections, tenant), //p
  }; //p
} //p
