/**
 * A born block's content fact lives in the graph create_note admitted it in;
 * the first update may come from another tenant (nomos writes as governance).
 * The update retracts the old content fact where it is held, so the slot keeps
 * one `tree_content` edge and every read agrees on it (capture 32501).
 */
import { describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { readContainer, readContainers } from "../src/container-read.js";
import { writeContainer } from "../src/container-write.js";
import { createNote, isCreateNoteError } from "../src/mcp/tools.js";
import { TREE_CONTENT, repointOps } from "../src/tree.js";

async function bornNote() {
  const dial = new FixtureChaosDial();
  dial.graphScoped = true;
  const blobs = new FixtureBlobStore();
  const res = await createNote(
    dial,
    "notes",
    { title: "Law" },
    undefined,
    blobs,
  );
  if (isCreateNoteError(res)) throw new Error(res.detail);
  const facet = { blobs, dial };
  const { blocks } = await readContainer(facet, res.node_id);
  const block = blocks[0];
  if (block === undefined || block.blobId === null) {
    throw new Error("create_note birthed no block");
  }
  return {
    dial,
    facet,
    note: res.node_id,
    slot: block.slot,
    born: block.blobId,
  };
}

async function contentEdges(dial: FixtureChaosDial, slot: string) {
  return (await dial.placedEdges(slot)).filter(
    (e) => e.predicate === TREE_CONTENT,
  );
}

describe("update across tenants (capture 32501)", () => {
  it("the graph-scoped fixture keeps a fact retracted in the wrong graph", async () => {
    const { dial, slot, born } = await bornNote();
    await dial.admit(repointOps(slot, born, "999"), "governance");
    expect(await contentEdges(dial, slot)).toHaveLength(2);
  });

  it("a governance update of a notes-born block leaves one content edge, and a CAS on read_container's blobId lands", async () => {
    const { dial, facet, note, slot, born } = await bornNote();
    const first = await writeContainer(
      facet,
      note,
      [{ op: "update", slot, oldBlobId: born, text: "first" }],
      "governance",
    );
    expect(await contentEdges(dial, slot)).toHaveLength(1);

    const head = await readContainer(facet, note);
    const batch = await readContainers(facet, [note], { texts: true });
    const headBlob = head.blocks[0]?.blobId;
    expect(headBlob).toBe(first.blobIds[0]);
    expect(batch.containers[0]?.blocks[0]?.blobId).toBe(headBlob);
    if (headBlob === null || headBlob === undefined) {
      throw new Error("no blob after the first update");
    }

    await writeContainer(
      facet,
      note,
      [{ op: "update", slot, oldBlobId: headBlob, text: "second" }],
      "governance",
    );
    expect((await readContainer(facet, note)).blocks[0]?.text).toBe("second");
    expect(await contentEdges(dial, slot)).toHaveLength(1);
  });
});
