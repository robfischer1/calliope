/**
 * The container read and history (spec 042) — SC-001..003 over the fixture
 * dial's transaction log (the door's contract, offline).
 */

import { describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial, opCreate } from "../src/chaos-client.js";
import { containerHistory, readContainer } from "../src/container-read.js";
import { writeContainer } from "../src/container-write.js";
import { readTree } from "../src/tree.js";

async function setup() {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const res = await dial.admit([opCreate("Note", "doc")], "notes");
  const doc = res.minted[0];
  if (doc === undefined) throw new Error("fixture minted nothing");
  return { dial, blobs, doc, facet: { blobs, dial } };
}

describe("the container read (042 F5)", () => {
  it("reads ordered blocks with text; empty is empty (SC-001)", async () => {
    const { facet, doc } = await setup();
    expect((await readContainer(facet, doc)).blocks).toEqual([]);

    await writeContainer(facet, doc, [
      { op: "add", text: "second", position: "a1" },
      { op: "add", text: "first", position: "a0" },
    ]);
    const read = await readContainer(facet, doc);
    expect(read.blocks.map((b) => b.text)).toEqual(["first", "second"]);
    expect(read.blocks.every((b) => !b.dangling)).toBe(true);
  });

  it("surfaces a dangling blob reference (SC-001)", async () => {
    const { facet, dial, doc } = await setup();
    await writeContainer(facet, doc, [
      { op: "add", text: "real", position: "a0" },
    ]);
    // A tree fact naming a blob the store never minted (a foreign id).
    const tree = await readTree(dial, doc);
    const slot = tree[0];
    if (slot?.blobId == null) throw new Error("bad setup");
    await writeContainer(facet, doc, [
      { op: "remove", slot: slot.slot, position: "a0", blobId: slot.blobId },
    ]);
    const { slotBirthOps } = await import("../src/tree.js");
    await dial.admit(slotBirthOps(doc, "b:a0", "a0", "999999"), "notes");

    const read = await readContainer(facet, doc);
    expect(read.blocks).toHaveLength(1);
    expect(read.blocks[0]?.dangling).toBe(true);
    expect(read.blocks[0]?.text).toBeNull();
    expect(read.blocks[0]?.blobId).toBe("999999");
  });

  it("reads the past: removed members reappear as-of (SC-002)", async () => {
    const { facet, dial, doc } = await setup();
    await writeContainer(facet, doc, [
      { op: "add", text: "keeper", position: "a0" },
      { op: "add", text: "doomed", position: "a1" },
    ]);
    const beforeTx = dial.factLog[dial.factLog.length - 1]?.tx;
    if (beforeTx === undefined) throw new Error("no tx");

    const tree = await readTree(dial, doc);
    const doomed = tree[1];
    if (doomed?.blobId == null) throw new Error("bad setup");
    await writeContainer(facet, doc, [
      {
        op: "remove",
        slot: doomed.slot,
        position: "a1",
        blobId: doomed.blobId,
      },
    ]);

    const head = await readContainer(facet, doc);
    expect(head.blocks.map((b) => b.text)).toEqual(["keeper"]);

    const past = await readContainer(facet, doc, { asOfTx: beforeTx });
    expect(past.asOfTx).toBe(beforeTx);
    expect(past.blocks.map((b) => b.text)).toEqual(["keeper", "doomed"]);
  });

  it("reads an edit's past text byte-identically (SC-002)", async () => {
    const { facet, dial, doc } = await setup();
    await writeContainer(facet, doc, [
      { op: "add", text: "version one", position: "a0" },
    ]);
    const v1Tx = dial.factLog[dial.factLog.length - 1]?.tx;
    if (v1Tx === undefined) throw new Error("no tx");
    const tree = await readTree(dial, doc);
    const slot = tree[0];
    if (slot?.blobId == null) throw new Error("bad setup");

    await writeContainer(facet, doc, [
      {
        op: "update",
        slot: slot.slot,
        oldBlobId: slot.blobId,
        text: "version two",
      },
    ]);
    expect((await readContainer(facet, doc)).blocks.map((b) => b.text)).toEqual(
      ["version two"],
    );
    expect(
      (await readContainer(facet, doc, { asOfTx: v1Tx })).blocks.map(
        (b) => b.text,
      ),
    ).toEqual(["version one"]);
  });

  it("lists N transactions for N edits, removed members included (SC-003)", async () => {
    const { facet, dial, doc } = await setup();
    // tx2: birth (tx1 was the container mint — no edges, not in history).
    await writeContainer(facet, doc, [
      { op: "add", text: "a", position: "a0" },
      { op: "add", text: "b", position: "a1" },
    ]);
    const tree = await readTree(dial, doc);
    const [s0, s1] = tree;
    if (s0?.blobId == null || s1?.blobId == null) throw new Error("bad setup");
    // tx3: edit s1. tx4: remove s1. tx5: edit s0.
    await writeContainer(facet, doc, [
      { op: "update", slot: s1.slot, oldBlobId: s1.blobId, text: "b2" },
    ]);
    await writeContainer(facet, doc, [
      { op: "remove", slot: s1.slot, position: "a1", blobId: "" },
    ]);
    await writeContainer(facet, doc, [
      { op: "update", slot: s0.slot, oldBlobId: s0.blobId, text: "a2" },
    ]);

    const history = await containerHistory(facet, doc);
    expect(history).toHaveLength(4);
    expect(history.map((h) => h.tx)).toEqual(
      [...history.map((h) => h.tx)].sort((x, y) => x - y),
    );
    expect(history.every((h) => h.author === FixtureChaosDialAuthor)).toBe(
      true,
    );
  });
});

const FixtureChaosDialAuthor = FixtureChaosDial.AUTHOR;
