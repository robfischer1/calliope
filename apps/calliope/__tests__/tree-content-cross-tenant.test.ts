/**
 * A born block's content fact lives in the graph create_note admitted it in;
 * the first update may come from another tenant (nomos writes as governance).
 * The update retracts the old content fact where it is held, so the slot keeps
 * one `tree_content` edge and every read agrees on it (capture 32501).
 */
import { describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial, opCreate } from "../src/chaos-client.js";
import { readContainer, readContainers } from "../src/container-read.js";
import { writeContainer } from "../src/container-write.js";
import { diffRevision, type SlotState } from "../src/mcp/migrate-tree.js";
import { createNote, isCreateNoteError } from "../src/mcp/tools.js";
import {
  TREE_CONTENT,
  TREE_MEMBER,
  TREE_REF,
  readTree,
  repointOps,
  slotBirthOps,
} from "../src/tree.js";

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
  const slot = blocks[0]?.slot;
  const born = blocks[0]?.blobId ?? null;
  if (slot === undefined || born === null) {
    throw new Error("create_note birthed no block");
  }
  return { dial, facet, note: res.node_id, slot, born };
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

  it("a governance remove of a notes-born block retracts all three facts where they are held", async () => {
    const { dial, facet, note, slot, born } = await bornNote();
    await writeContainer(
      facet,
      note,
      [{ op: "remove", slot, position: "a0", blobId: born }],
      "governance",
    );
    expect(await readTree(dial, note)).toEqual([]);
    expect(await dial.placedEdges(slot)).toEqual([]);
    const members = (await dial.placedEdges(note)).filter(
      (e) => e.predicate === TREE_MEMBER,
    );
    expect(members).toEqual([]);
  });

  it("a governance remove of a notes-born placement retracts membership, position and reference where they are held", async () => {
    const origin = await bornNote();
    await writeContainer(
      origin.facet,
      origin.note,
      [{ op: "update", slot: origin.slot, oldBlobId: origin.born, text: "x" }],
      "notes",
    );
    const { dial, facet, slot: bornSlot } = origin;
    const box = await createNote(
      dial,
      "notes",
      { title: "Box" },
      undefined,
      facet.blobs,
    );
    if (isCreateNoteError(box)) throw new Error(box.detail);
    const tree = await readContainer(facet, box.node_id);
    const empty = tree.blocks[0];
    if (empty?.blobId === undefined || empty.blobId === null) {
      throw new Error("create_note birthed no block");
    }
    await writeContainer(
      facet,
      box.node_id,
      [
        {
          op: "remove",
          slot: empty.slot,
          position: empty.position,
          blobId: empty.blobId,
        },
      ],
      "notes",
    );
    const placed = await writeContainer(
      facet,
      box.node_id,
      [{ op: "add", ref: bornSlot, position: "b0" }],
      "notes",
    );
    const placement = placed.minted[0] ?? "";
    expect(placement).not.toBe("");
    const placementSlot = (await readTree(dial, box.node_id))[0];
    expect(placementSlot?.ref).toBe(bornSlot);

    await writeContainer(
      facet,
      box.node_id,
      [
        {
          op: "remove",
          slot: placement,
          position: "b0",
          blobId: "",
        },
      ],
      "governance",
    );
    expect(await readTree(dial, box.node_id)).toEqual([]);
    const refs = (await dial.placedEdges(placement)).filter(
      (e) => e.predicate === TREE_REF,
    );
    expect(refs).toEqual([]);
    expect(await dial.placedEdges(placement)).toEqual([]);
    const members = (await dial.placedEdges(box.node_id)).filter(
      (e) => e.predicate === TREE_MEMBER,
    );
    expect(members).toEqual([]);
  });

  it("migrate-tree's diff, admitted in another scope, repoints and removes notes-held slots", async () => {
    const dial = new FixtureChaosDial();
    dial.graphScoped = true;
    const blobs = new FixtureBlobStore();
    const minted = async (res: Promise<{ minted: string[] }>) => {
      const token = (await res).minted[0];
      if (token === undefined) throw new Error("fixture minted nothing");
      return token;
    };
    const doc = await minted(dial.admit([opCreate("Note", "doc")], "notes"));
    const birth = (pos: string, blobId: string): Promise<string> =>
      minted(dial.admit(slotBirthOps(doc, "b", pos, blobId), "notes"));
    const one = await blobs.mint("one");
    const two = await blobs.mint("two");
    const kept = await birth("a0", one);
    const dropped = await birth("a1", two);
    const slots = new Map<string, SlotState>([
      ["s1", { slot: kept, position: "a0", blobId: one, text: "one" }],
      ["s2", { slot: dropped, position: "a1", blobId: two, text: "two" }],
    ]);
    const { batch } = await diffRevision(
      dial,
      doc,
      slots,
      [{ id: "s1", text: "ONE", orderKey: "a0" }],
      new Map(),
      (text) => blobs.mint(text),
    ).build();
    await dial.admit(batch, "governance");

    const tree = await readTree(dial, doc);
    expect(tree.map((t) => t.slot)).toEqual([kept]);
    expect(tree[0]?.blobId).toBe(await blobs.mint("ONE"));
    expect(await contentEdges(dial, kept)).toHaveLength(1);
    expect(await dial.placedEdges(dropped)).toEqual([]);
  });
});
