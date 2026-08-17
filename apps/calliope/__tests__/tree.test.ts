/**
 * The tree (spec 040) — SC-001..005 over the fixture dial, which models
 * themis's batch-local label rule and the F2 blob edge domain exactly
 * (a fixture diverging from the door's rule would be a false pass).
 */

import { describe, expect, it } from "vitest";
import {
  FixtureChaosDial,
  notesScope,
  opCreate,
  tenantScope,
} from "../src/chaos-client.js";
import {
  BLOCK_KIND,
  TREE_CONTENT,
  moveOps,
  readTree,
  repointOps,
  repositionOps,
  slotBirthOps,
  slotRemoveOps,
  readTree as readTreeAgain,
} from "../src/tree.js";

async function mintContainer(dial: FixtureChaosDial, label: string) {
  const res = await dial.admit([opCreate("Note", label)], "notes");
  return mintedToken(res.minted);
}

function mintedToken(minted: string[], index = 0): string {
  const token = minted[index];
  if (token === undefined) throw new Error("fixture minted nothing");
  return token;
}

describe("the tree (040 F3)", () => {
  it("resolves 0, 1, and many members in position order (SC-001)", async () => {
    const dial = new FixtureChaosDial();
    const doc = await mintContainer(dial, "doc");

    expect(await readTree(dial, doc)).toEqual([]); // empty ≠ absent

    // Insert out of order; the read sorts bytewise.
    for (const [label, pos, blob] of [
      ["b:a2", "a2", "12"],
      ["b:a0", "a0", "10"],
      ["b:a1", "a1", "11"],
    ] as const) {
      const res = await dial.admit(
        slotBirthOps(doc, label, pos, blob),
        "notes",
      );
      expect(res.admitted).toBe(true);
    }
    const tree = await readTree(dial, doc);
    expect(tree.map((s) => s.position)).toEqual(["a0", "a1", "a2"]);
    expect(tree.map((s) => s.blobId)).toEqual(["10", "11", "12"]);
  });

  it("births a slot in ONE admit batch, labels resolved (SC-005)", async () => {
    const dial = new FixtureChaosDial();
    const doc = await mintContainer(dial, "doc");
    const before = dial.admits.length;
    const res = await dial.admit(
      slotBirthOps(doc, "b:a0", "a0", "17"),
      "notes",
    );
    expect(dial.admits.length).toBe(before + 1); // one batch, one transaction
    const slotToken = mintedToken(res.minted);
    const tree = await readTree(dial, doc);
    expect(tree).toEqual([{ slot: slotToken, position: "a0", blobId: "17" }]);
  });

  it("shares one blob across two containers and twice in one (SC-002)", async () => {
    const dial = new FixtureChaosDial();
    const a = await mintContainer(dial, "a");
    const b = await mintContainer(dial, "b");
    await dial.admit(slotBirthOps(a, "b:a0", "a0", "77"), "notes");
    await dial.admit(slotBirthOps(a, "b:a1", "a1", "77"), "notes"); // twice in one
    await dial.admit(slotBirthOps(b, "b:a0", "a0", "77"), "notes"); // and in another
    const treeA = await readTree(dial, a);
    const treeB = await readTree(dial, b);
    expect(treeA.map((s) => s.blobId)).toEqual(["77", "77"]);
    expect(treeB.map((s) => s.blobId)).toEqual(["77"]);
    // No blob was duplicated: the id is the identity, and every reference
    // carries the same one.
    expect(new Set([...treeA, ...treeB].map((s) => s.blobId)).size).toBe(1);
  });

  it("moves between containers without touching the blob (SC-003)", async () => {
    const dial = new FixtureChaosDial();
    const a = await mintContainer(dial, "a");
    const b = await mintContainer(dial, "b");
    const res = await dial.admit(slotBirthOps(a, "b:a0", "a0", "42"), "notes");
    const slot = mintedToken(res.minted);

    const ops = moveOps(slot, a, b);
    // The move touches ONLY membership: no op names the content predicate,
    // and nothing mints.
    expect(ops.every((o) => o.predicate !== TREE_CONTENT)).toBe(true);
    expect(ops.every((o) => o.op !== "createNode")).toBe(true);
    await dial.admit(ops, "notes");

    expect(await readTree(dial, a)).toEqual([]);
    expect(await readTreeAgain(dial, b)).toEqual([
      { slot, position: "a0", blobId: "42" },
    ]);
  });

  it("reorders without minting and repoints without reordering (SC-003)", async () => {
    const dial = new FixtureChaosDial();
    const doc = await mintContainer(dial, "doc");
    const r1 = await dial.admit(slotBirthOps(doc, "b:a0", "a0", "1"), "notes");
    const r2 = await dial.admit(slotBirthOps(doc, "b:a1", "a1", "2"), "notes");
    const [s1, s2] = [mintedToken(r1.minted), mintedToken(r2.minted)];

    const reorder = repositionOps(s1, "a0", "a1V"); // between a1 and a2
    expect(reorder.every((o) => o.op !== "createNode")).toBe(true);
    await dial.admit(reorder, "notes");
    expect((await readTree(dial, doc)).map((s) => s.slot)).toEqual([s2, s1]);

    await dial.admit(repointOps(s2, "2", "9"), "notes");
    const tree = await readTree(dial, doc);
    expect(tree.find((s) => s.slot === s2)?.blobId).toBe("9");
    expect(tree.find((s) => s.slot === s2)?.position).toBe("a1"); // unmoved
  });

  it("removes a slot's three facts (and only those)", async () => {
    const dial = new FixtureChaosDial();
    const doc = await mintContainer(dial, "doc");
    const r1 = await dial.admit(slotBirthOps(doc, "b:a0", "a0", "5"), "notes");
    await dial.admit(slotBirthOps(doc, "b:a1", "a1", "6"), "notes");
    await dial.admit(
      slotRemoveOps(mintedToken(r1.minted), doc, "a0", "5"),
      "notes",
    );
    const tree = await readTree(dial, doc);
    expect(tree.map((s) => s.blobId)).toEqual(["6"]);
  });

  it("surfaces a dangling slot instead of skipping it", async () => {
    const dial = new FixtureChaosDial();
    const doc = await mintContainer(dial, "doc");
    const res = await dial.admit(slotBirthOps(doc, "b:a0", "a0", "3"), "notes");
    const slot = mintedToken(res.minted);
    // The content fact retracts; the slot stays a member.
    await dial.admit(repointOps(slot, "3", "3").slice(0, 1), "notes");
    const tree = await readTree(dial, doc);
    expect(tree).toEqual([{ slot, position: "a0", blobId: null }]);
  });

  it("isolates tenants: documents-scoped writes are invisible to notes (SC-004)", async () => {
    const dial = new FixtureChaosDial();
    const doc = await mintContainer(dial, "doc");
    await dial.admit(
      slotBirthOps(doc, "b:a0", "a0", "8"),
      tenantScope("documents"),
    );
    const scopes = dial.admits.map((a) => a.scope);
    expect(scopes).toContain("documents");
    // Every tree write names its tenant's graph; nothing tree-shaped landed
    // in the notes scope.
    const notesBatches = dial.admits.filter((a) => a.scope === "notes");
    expect(
      notesBatches.every((a) =>
        a.ops.every((o) => o.predicate !== TREE_CONTENT),
      ),
    ).toBe(true);
  });

  it("resolves tenant scopes with the notes compat pin", () => {
    expect(tenantScope("notes")).toBe(notesScope());
    expect(tenantScope("documents")).toBe("documents");
    expect(
      tenantScope("governance", {
        CALLIOPE_GOVERNANCE_SCOPE: "gov-x",
      }),
    ).toBe("gov-x");
  });

  it("registers tenant graphs idempotently on the dial", async () => {
    const dial = new FixtureChaosDial();
    await dial.registerGraph("documents");
    await dial.registerGraph("documents");
    expect([...dial.graphs]).toEqual(["documents"]);
  });

  it("mints slots under the Block kind", () => {
    const ops = slotBirthOps("c0ffee", "b:a0", "a0", "1");
    expect(ops[0]).toMatchObject({ op: "createNode", kind: BLOCK_KIND });
    expect(ops[3]).toMatchObject({ to_blob: "1" });
    expect(ops[3]).not.toHaveProperty("to_node", "b:a0");
  });
});
