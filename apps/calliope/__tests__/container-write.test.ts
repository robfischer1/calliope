/**
 * The container write (spec 041) — SC-001..005: blob-first ordering,
 * netting, one batch per save, refusal leaves orphans and no tree change.
 */

import { describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import {
  ChaosClientError,
  FixtureChaosDial,
  opAdd,
  opCreate,
} from "../src/chaos-client.js";
import { writeContainer } from "../src/container-write.js";
import { TREE_CONTENT, readTree } from "../src/tree.js";

async function setup() {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const res = await dial.admit([opCreate("Note", "doc")], "notes");
  const doc = res.minted[0];
  if (doc === undefined) throw new Error("fixture minted nothing");
  return { dial, blobs, doc, facet: { blobs, dial } };
}

describe("the container write (041 F4)", () => {
  it("saves a three-block document, then edits one block (SC-001)", async () => {
    const { facet, dial, blobs, doc } = await setup();
    const first = await writeContainer(facet, doc, [
      { op: "add", text: "alpha", position: "a0" },
      { op: "add", text: "beta", position: "a1" },
      { op: "add", text: "gamma", position: "a2" },
    ]);
    expect(first.noop).toBe(false);
    expect(Object.keys(first.minted)).toHaveLength(3);
    expect(blobs.size).toBe(3);

    const tree = await readTree(dial, doc);
    const betaSlot = tree[1];
    if (betaSlot === undefined) throw new Error("no beta slot");
    const admitsBefore = dial.admits.length;

    const edit = await writeContainer(facet, doc, [
      {
        op: "update",
        slot: betaSlot.slot,
        oldBlobId: betaSlot.blobId ?? "",
        text: "beta, revised",
      },
    ]);
    expect(edit.noop).toBe(false);
    expect(blobs.size).toBe(4); // exactly one new blob
    expect(dial.admits.length).toBe(admitsBefore + 1); // one batch

    const after = await readTree(dial, doc);
    expect(after.map((s) => s.blobId)).toEqual([
      tree[0]?.blobId ?? null,
      edit.blobIds[0] ?? null,
      tree[2]?.blobId ?? null,
    ]);
    // N-1 slots untouched: same slot tokens, same positions.
    expect(after.map((s) => s.slot)).toEqual(tree.map((s) => s.slot));
  });

  it("nets identical content to nothing (SC-002)", async () => {
    const { facet, dial, blobs, doc } = await setup();
    await writeContainer(facet, doc, [
      { op: "add", text: "stable prose", position: "a0" },
    ]);
    const tree = await readTree(dial, doc);
    const slot = tree[0];
    if (slot?.blobId == null) throw new Error("no slot");
    const blobsBefore = blobs.size;
    const admitsBefore = dial.admits.length;

    const res = await writeContainer(facet, doc, [
      {
        op: "update",
        slot: slot.slot,
        oldBlobId: slot.blobId,
        text: "stable prose",
      },
    ]);
    expect(res.noop).toBe(true);
    expect(res.applied).toEqual([]);
    expect(blobs.size).toBe(blobsBefore); // dedup — no row
    expect(dial.admits.length).toBe(admitsBefore); // no transaction at all
  });

  it("carries only the real ops of a mixed batch (SC-003)", async () => {
    const { facet, dial, doc } = await setup();
    await writeContainer(facet, doc, [
      { op: "add", text: "one", position: "a0" },
      { op: "add", text: "two", position: "a1" },
    ]);
    const tree = await readTree(dial, doc);
    const [s0, s1] = tree;
    if (!s0 || !s1 || s0.blobId === null || s1.blobId === null)
      throw new Error("bad setup");
    const admitsBefore = dial.admits.length;

    const res = await writeContainer(facet, doc, [
      { op: "update", slot: s0.slot, oldBlobId: s0.blobId, text: "one" }, // no-op
      { op: "update", slot: s1.slot, oldBlobId: s1.blobId, text: "two'" }, // real
    ]);
    expect(res.noop).toBe(false);
    expect(res.applied).toEqual([1]);
    expect(dial.admits.length).toBe(admitsBefore + 1);
    const batch = dial.admits[dial.admits.length - 1];
    // Only the real op's facts rode: one retract + one assert, both content.
    expect(batch?.ops).toHaveLength(2);
    expect(batch?.ops.every((o) => o.predicate === TREE_CONTENT)).toBe(true);
  });

  it("surfaces a refusal, leaves orphans, changes no tree (SC-004)", async () => {
    const { facet, dial, blobs, doc } = await setup();
    await writeContainer(facet, doc, [
      { op: "add", text: "kept", position: "a0" },
    ]);
    const before = await readTree(dial, doc);
    dial.refuseWith = [{ check: "shape", detail: "fixture says no" }];

    await expect(
      writeContainer(facet, doc, [
        { op: "add", text: "refused prose", position: "a1" },
      ]),
    ).rejects.toThrow(ChaosClientError);
    dial.refuseWith = null;

    // Blob-first: the mint happened (orphan), the tree did not change.
    expect(await blobs.findByContent("refused prose")).not.toBeNull();
    expect(await readTree(dial, doc)).toEqual(before);
  });

  describe("compare-and-set on update", () => {
    async function twoBlocks() {
      const ctx = await setup();
      await writeContainer(ctx.facet, ctx.doc, [
        { op: "add", text: "one", position: "a0" },
        { op: "add", text: "two", position: "a1" },
      ]);
      const [s0, s1] = await readTree(ctx.dial, ctx.doc);
      if (!s0?.blobId || !s1?.blobId) throw new Error("bad setup");
      return { ...ctx, s0, s1, b0: s0.blobId, b1: s1.blobId };
    }
    const contentOf = async (
      dial: FixtureChaosDial,
      slot: string,
    ): Promise<string[]> =>
      (await dial.edges(slot))
        .filter((e) => e.predicate === TREE_CONTENT)
        .map((e) => e.value);

    it("every update carries a held expectation of its old blob", async () => {
      const { facet, dial, doc, s0, b0 } = await twoBlocks();
      const seen: unknown[] = [];
      const inner = dial.admit.bind(dial);
      dial.admit = (ops, scope, expect) => {
        seen.push(expect);
        return inner(ops, scope, expect);
      };
      await writeContainer(facet, doc, [
        { op: "update", slot: s0.slot, oldBlobId: b0, text: "one'" },
      ]);
      expect(seen).toEqual([
        [{ s: s0.slot, predicate: TREE_CONTENT, held: [{ $blob: b0 }] }],
      ]);
    });

    it("a matching oldBlobId succeeds and leaves one content fact", async () => {
      const { facet, dial, doc, s0, b0 } = await twoBlocks();
      const res = await writeContainer(facet, doc, [
        { op: "update", slot: s0.slot, oldBlobId: b0, text: "one'" },
      ]);
      expect(res.noop).toBe(false);
      expect(await contentOf(dial, s0.slot)).toEqual([res.blobIds[0]]);
    });

    it("a stale oldBlobId refuses as conflict naming the slot, writing nothing", async () => {
      const { facet, dial, doc, s0, b0 } = await twoBlocks();
      // another writer moves the slot after the caller read b0
      const other = await writeContainer(facet, doc, [
        { op: "update", slot: s0.slot, oldBlobId: b0, text: "one, theirs" },
      ]);
      const theirs = other.blobIds[0];
      const before = await readTree(dial, doc);
      const err = await writeContainer(facet, doc, [
        { op: "update", slot: s0.slot, oldBlobId: b0, text: "one, mine" },
      ]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChaosClientError);
      expect((err as ChaosClientError).code).toBe("conflict");
      expect((err as ChaosClientError).message).toContain(s0.slot);
      expect(await readTree(dial, doc)).toEqual(before);
      expect(await contentOf(dial, s0.slot)).toEqual([theirs]);
    });

    it("a multi-op batch is all-or-nothing when one update is stale", async () => {
      const { facet, dial, doc, s0, s1, b0, b1 } = await twoBlocks();
      await writeContainer(facet, doc, [
        { op: "update", slot: s1.slot, oldBlobId: b1, text: "two, theirs" },
      ]);
      const before = await readTree(dial, doc);
      const err = await writeContainer(facet, doc, [
        { op: "update", slot: s0.slot, oldBlobId: b0, text: "one, mine" }, // fresh
        { op: "update", slot: s1.slot, oldBlobId: b1, text: "two, mine" }, // stale
      ]).catch((e: unknown) => e);
      expect((err as ChaosClientError).code).toBe("conflict");
      expect((err as ChaosClientError).message).toContain(s1.slot);
      // the fresh half did not land either
      expect(await readTree(dial, doc)).toEqual(before);
      expect(await contentOf(dial, s0.slot)).toEqual([b0]);
    });

    it("a stale remove refuses conflict and changes nothing", async () => {
      const { facet, dial, doc, s0, b0 } = await twoBlocks();
      await writeContainer(facet, doc, [
        { op: "update", slot: s0.slot, oldBlobId: b0, text: "one, theirs" },
      ]);
      const before = await readTree(dial, doc);
      const err = await writeContainer(facet, doc, [
        { op: "remove", slot: s0.slot, position: "a0", blobId: b0 },
      ]).catch((e: unknown) => e);
      expect((err as ChaosClientError).code).toBe("conflict");
      expect((err as ChaosClientError).message).toContain(s0.slot);
      expect(await readTree(dial, doc)).toEqual(before);
    });

    it("a fresh remove still succeeds", async () => {
      const { facet, dial, doc, s0, b0 } = await twoBlocks();
      await writeContainer(facet, doc, [
        { op: "remove", slot: s0.slot, position: "a0", blobId: b0 },
      ]);
      expect((await readTree(dial, doc)).map((s) => s.slot)).not.toContain(
        s0.slot,
      );
    });

    it("a slot already holding two contents refuses (held is exact)", async () => {
      const { facet, dial, doc, s0, b0 } = await twoBlocks();
      await dial.admit(
        [opAdd(s0.slot, TREE_CONTENT, { toBlob: "999" })],
        "notes",
      );
      await expect(
        writeContainer(facet, doc, [
          { op: "update", slot: s0.slot, oldBlobId: b0, text: "one'" },
        ]),
      ).rejects.toMatchObject({ code: "conflict" });
    });
  });

  it("saves unsplittable prose as one block (SC-005)", async () => {
    const { facet, dial, doc } = await setup();
    const res = await writeContainer(facet, doc, [
      { op: "add", text: "the whole document, one block", position: "a0" },
    ]);
    expect(res.noop).toBe(false);
    const tree = await readTree(dial, doc);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.blobId).toBe(res.blobIds[0]);
  });

  it("reorders and removes without minting", async () => {
    const { facet, dial, blobs, doc } = await setup();
    await writeContainer(facet, doc, [
      { op: "add", text: "x", position: "a0" },
      { op: "add", text: "y", position: "a1" },
    ]);
    const tree = await readTree(dial, doc);
    const [s0, s1] = tree;
    if (!s0 || !s1) throw new Error("bad setup");
    const blobsBefore = blobs.size;

    await writeContainer(facet, doc, [
      { op: "reorder", slot: s0.slot, oldPosition: "a0", position: "a2" },
    ]);
    await writeContainer(facet, doc, [
      { op: "remove", slot: s1.slot, position: "a1", blobId: s1.blobId ?? "" },
    ]);
    expect(blobs.size).toBe(blobsBefore); // nothing minted
    const after = await readTree(dial, doc);
    expect(after.map((s) => s.slot)).toEqual([s0.slot]);
    expect(after[0]?.position).toBe("a2");
  });

  it("gives two adds in one save distinct batch labels", async () => {
    const { facet, dial, doc } = await setup();
    const res = await writeContainer(facet, doc, [
      { op: "add", text: "p", position: "a0" },
      { op: "add", text: "q", position: "a1" },
    ]);
    expect(new Set(Object.values(res.minted)).size).toBe(2);
    const tree = await readTree(dial, doc);
    expect(tree.map((s) => s.position)).toEqual(["a0", "a1"]);
  });

  it("carries the admit's tx, and none when the gate answers none", async () => {
    const { facet, dial, doc } = await setup();
    const first = await writeContainer(facet, doc, [
      { op: "add", text: "with tx", position: "a0" },
    ]);
    expect(typeof first.tx).toBe("number");
    const admit = dial.admit.bind(dial);
    dial.admit = async (ops, scope) => {
      const r = await admit(ops, scope);
      return {
        admitted: r.admitted,
        minted: r.minted,
        violations: r.violations,
      };
    };
    const second = await writeContainer(facet, doc, [
      { op: "add", text: "without tx", position: "a1" },
    ]);
    expect(second.noop).toBe(false);
    expect(second).not.toHaveProperty("tx");
  });
});
