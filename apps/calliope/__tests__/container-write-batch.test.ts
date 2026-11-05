/**
 * What a container save puts in its batch and what it asks the gate to hold,
 * pinned op by op: placement births, edits through a placement, placement
 * removals, the span-window replace, and the post-commit orphan report.
 * Synthetic fixtures only.
 */

import { describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import {
  ChaosClientError,
  type ChaosExpect,
  FixtureChaosDial,
  opCreate,
} from "../src/chaos-client.js";
import { saveContainerBody, containerBodies } from "../src/container-body.js";
import { readContainer } from "../src/container-read.js";
import { type ContainerOp, writeContainer } from "../src/container-write.js";
import {
  TREE_CONTENT,
  TREE_REF,
  placementBirthOps,
  readTree,
  slotBirthOps,
} from "../src/tree.js";

function rig() {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const facet = { blobs, dial };
  const note = async (label: string) => {
    const res = await dial.admit([opCreate("Note", label)], "notes");
    return res.minted[0] ?? "";
  };
  const withBlock = async (label: string, text: string) => {
    const c = await note(label);
    const w = await writeContainer(facet, c, [
      { op: "add", text, position: "a0" },
    ]);
    return { c, slot: w.minted[0] ?? "" };
  };
  const seen: ChaosExpect[][] = [];
  const inner = dial.admit.bind(dial);
  dial.admit = (ops, scope, expects) => {
    seen.push(expects ?? []);
    return inner(ops, scope, expects);
  };
  const blockOf = async (c: string, slot: string) => {
    const b = (await readContainer(facet, c)).blocks.find(
      (x) => x.slot === slot,
    );
    if (b === undefined) throw new Error("no block");
    return b;
  };
  return { dial, blobs, facet, note, withBlock, seen, blockOf };
}

describe("a placement add", () => {
  it("is born under its position, holds the origin's blob, and mints one token per op", async () => {
    const r = rig();
    const { c: a, slot: origin } = await r.withBlock("a", "shared");
    const b = await r.note("b");
    const w = await writeContainer(r.facet, b, [
      { op: "add", ref: origin, position: "b7" },
      { op: "add", text: "plain", position: "b8" },
      { op: "add", ref: origin, position: "b9" },
    ]);
    // The batch is exactly the placement birth for the first op.
    const ops = r.dial.admits.at(-1)?.ops ?? [];
    expect(ops.slice(0, 4)).toEqual(placementBirthOps(b, "b:b7", "b7", origin));
    // The origin is held at the blob the plan read.
    const originBlob = (await r.blockOf(a, origin)).blobId ?? "";
    expect(r.seen.at(-1)?.[0]).toEqual({
      s: origin,
      predicate: TREE_CONTENT,
      held: [{ $blob: originBlob }],
    });
    // Each add got its own token, in op order: ordinals advance by one.
    const tokens = [w.minted[0], w.minted[1], w.minted[2]];
    expect(new Set(tokens).size).toBe(3);
    const tree = await readTree(r.dial, b);
    const byPos = new Map(tree.map((t) => [t.position, t]));
    expect(byPos.get("b7")?.slot).toBe(tokens[0]);
    expect(byPos.get("b8")?.slot).toBe(tokens[1]);
    expect(byPos.get("b9")?.slot).toBe(tokens[2]);
    expect(byPos.get("b7")?.ref).toBe(origin);
    expect(byPos.get("b8")?.blobId).not.toBeNull();
    expect(byPos.get("b9")?.ref).toBe(origin);
    expect((await r.blockOf(b, tokens[0] ?? "")).position).toBe("b7");
  });
});

describe("a plain text add", () => {
  it("lands exactly the slot's birth ops: no stray fact", async () => {
    const r = rig();
    const c = await r.note("c");
    const w = await writeContainer(r.facet, c, [
      { op: "add", text: "solo", position: "a0" },
    ]);
    const [slot] = await readTree(r.dial, c);
    expect(w.minted[0]).toBe(slot?.slot);
    const ops = r.dial.admits.at(-1)?.ops ?? [];
    expect(ops).toEqual(slotBirthOps(c, "b:a0", "a0", slot?.blobId ?? "", []));
  });
});

describe("an edit through a placement", () => {
  it("holds the placement's reference and the origin's blob, and reports routed", async () => {
    const r = rig();
    const { c: a, slot: origin } = await r.withBlock("a", "v1");
    const b = await r.note("b");
    const p =
      (
        await writeContainer(r.facet, b, [
          { op: "add", ref: origin, position: "b0" },
        ])
      ).minted[0] ?? "";
    const oldBlob = (await r.blockOf(a, origin)).blobId ?? "";
    const w = await writeContainer(r.facet, b, [
      { op: "update", slot: p, oldBlobId: oldBlob, text: "v2" },
    ]);
    expect(r.seen.at(-1)).toEqual([
      { s: p, predicate: TREE_REF, held: [{ node: origin }] },
      { s: origin, predicate: TREE_CONTENT, held: [{ $blob: oldBlob }] },
    ]);
    expect(w.routed).toEqual({ 0: origin });
    // Updating an origin that has placements removes nothing: no orphans.
    const next = (await r.blockOf(a, origin)).blobId ?? "";
    const w2 = await writeContainer(r.facet, a, [
      { op: "update", slot: origin, oldBlobId: next, text: "v3" },
    ]);
    expect(w2).not.toHaveProperty("orphaned");
    expect(w2).not.toHaveProperty("routed");
    // A plain (unrouted) update holds no placement reference.
    expect(r.seen.at(-1)?.map((e) => e.predicate)).toEqual([TREE_CONTENT]);
  });

  it("a facts-only edit through a placement still holds the reference, not the content", async () => {
    const r = rig();
    const { c: a, slot: origin } = await r.withBlock("a", "same");
    const b = await r.note("b");
    const p =
      (
        await writeContainer(r.facet, b, [
          { op: "add", ref: origin, position: "b0" },
        ])
      ).minted[0] ?? "";
    const blob = (await r.blockOf(a, origin)).blobId ?? "";
    await writeContainer(r.facet, b, [
      {
        op: "update",
        slot: p,
        oldBlobId: blob,
        text: "same",
        facts: [{ predicate: "contentHash" }],
      },
    ]);
    expect(r.seen.at(-1)).toEqual([
      { s: p, predicate: TREE_REF, held: [{ node: origin }] },
    ]);
  });
});

describe("removing a placement", () => {
  it("holds its reference and the origin's content; a dangling one holds only the reference", async () => {
    const r = rig();
    const { c: a, slot: origin } = await r.withBlock("a", "going");
    const b = await r.note("b");
    const p =
      (
        await writeContainer(r.facet, b, [
          { op: "add", ref: origin, position: "b0" },
        ])
      ).minted[0] ?? "";
    const src = await r.blockOf(a, origin);
    await writeContainer(r.facet, b, [
      { op: "remove", slot: p, position: "b0", blobId: src.blobId ?? "" },
    ]);
    expect(r.seen.at(-1)).toEqual([
      { s: p, predicate: TREE_REF, held: [{ node: origin }] },
      { s: origin, predicate: TREE_CONTENT, held: [{ $blob: src.blobId }] },
    ]);
    // Dangling: the origin is gone, the placement is removed with blobId "".
    const q =
      (
        await writeContainer(r.facet, b, [
          { op: "add", ref: origin, position: "b1" },
        ])
      ).minted[0] ?? "";
    await writeContainer(r.facet, a, [
      {
        op: "remove",
        slot: origin,
        position: src.position,
        blobId: src.blobId ?? "",
        placements: "orphan",
      },
    ]);
    await writeContainer(r.facet, b, [
      { op: "remove", slot: q, position: "b1", blobId: "" },
    ]);
    expect(r.seen.at(-1)).toEqual([
      { s: q, predicate: TREE_REF, held: [{ node: origin }] },
    ]);
  });
});

describe("facts on an op that takes none", () => {
  it("a remove or a reorder carrying facts is not validated", async () => {
    const r = rig();
    const c = await r.note("c");
    await writeContainer(r.facet, c, [
      { op: "add", text: "x", position: "a0" },
    ]);
    const [s] = await readTree(r.dial, c);
    const bogus = [{ predicate: "madeUp", literal: "v" }];
    const reorder = {
      op: "reorder",
      slot: s?.slot ?? "",
      oldPosition: "a0",
      position: "a1",
      facts: bogus,
    } as unknown as ContainerOp;
    await expect(writeContainer(r.facet, c, [reorder])).resolves.toMatchObject({
      noop: false,
    });
    const remove = {
      op: "remove",
      slot: s?.slot ?? "",
      position: "a1",
      blobId: s?.blobId ?? "",
      facts: bogus,
    } as unknown as ContainerOp;
    await expect(writeContainer(r.facet, c, [remove])).resolves.toMatchObject({
      noop: false,
    });
  });
});

describe("a facts-only update leaves the held contentHash alone", () => {
  it("lays only the carried fact: no hash retract, no hash re-add", async () => {
    const r = rig();
    const c = await r.note("c");
    await writeContainer(r.facet, c, [
      {
        op: "add",
        text: "v1",
        position: "a0",
        facts: [{ predicate: "contentHash" }],
      },
    ]);
    const [s] = await readTree(r.dial, c);
    await writeContainer(r.facet, c, [
      {
        op: "update",
        slot: s?.slot ?? "",
        oldBlobId: s?.blobId ?? "",
        text: "v1",
        facts: [{ predicate: "turnsDigest", literal: "0123456789abcdef" }],
      },
    ]);
    const ops = r.dial.admits.at(-1)?.ops ?? [];
    expect(ops.map((o) => o.predicate)).toEqual(["turnsDigest"]);
  });
});

describe("the turn window is replaced by either bound alone", () => {
  async function seeded() {
    const r = rig();
    const c = await r.note("t");
    await writeContainer(r.facet, c, [
      {
        op: "add",
        text: "v1",
        position: "a0",
        facts: [
          { predicate: "spanFrom", literal: "0" },
          { predicate: "spanTo", literal: "5" },
        ],
      },
    ]);
    const [s] = await readTree(r.dial, c);
    const update = (facts: { predicate: string; literal: string }[]) =>
      writeContainer(r.facet, c, [
        {
          op: "update",
          slot: s?.slot ?? "",
          oldBlobId: s?.blobId ?? "",
          text: "v1",
          facts,
        },
      ]);
    const facts = async () =>
      (await readContainer(r.facet, c, { facts: true })).blocks[0]?.facts;
    return { update, facts };
  }

  it("a lone spanFrom replaces the held spanFrom", async () => {
    const s = await seeded();
    await s.update([{ predicate: "spanFrom", literal: "2" }]);
    expect(await s.facts()).toEqual([
      { predicate: "spanFrom", form: "literal", value: "2" },
      { predicate: "spanTo", form: "literal", value: "5" },
    ]);
  });

  it("a lone spanTo replaces the held spanTo", async () => {
    const s = await seeded();
    await s.update([{ predicate: "spanTo", literal: "9" }]);
    expect(await s.facts()).toEqual([
      { predicate: "spanFrom", form: "literal", value: "0" },
      { predicate: "spanTo", form: "literal", value: "9" },
    ]);
  });

  it("the same window written again answers an empty noop", async () => {
    const s = await seeded();
    const r = await s.update([
      { predicate: "spanFrom", literal: "0" },
      { predicate: "spanTo", literal: "5" },
    ]);
    expect(r.noop).toBe(true);
    expect(r.applied).toEqual([]);
    expect(r.minted).toEqual({});
  });
});

describe("the minted tokens a gate answers", () => {
  it("an add whose token the gate did not answer is absent from minted", async () => {
    const r = rig();
    const c = await r.note("c");
    r.dial.admit = () =>
      Promise.resolve({ admitted: true, minted: [], violations: [] });
    const w = await writeContainer(r.facet, c, [
      { op: "add", text: "x", position: "a0" },
    ]);
    expect(Object.keys(w.minted)).toEqual([]);
    expect(w.applied).toEqual([0]);
  });
});

describe("how a conflict names its slot", () => {
  it("reads a multi-digit expectation index", async () => {
    const r = rig();
    const c = await r.note("c");
    const texts = Array.from({ length: 12 }, (_, i) => `t${String(i)}`);
    await writeContainer(
      r.facet,
      c,
      texts.map((text, i) => ({
        op: "add" as const,
        text,
        position: `a${String(i).padStart(2, "0")}`,
      })),
    );
    const tree = await readTree(r.dial, c);
    r.dial.admit = () =>
      Promise.reject(new ChaosClientError("expect[10] s=zz", "conflict"));
    const err = (await writeContainer(
      r.facet,
      c,
      tree.map((t) => ({
        op: "update" as const,
        slot: t.slot,
        oldBlobId: t.blobId ?? "",
        text: `${t.slot.slice(0, 4)}x`,
      })),
    ).catch((e: unknown) => e)) as ChaosClientError;
    expect(err.code).toBe("conflict");
    expect(err.message).toContain(
      `slot ${tree[10]?.slot ?? ""} no longer holds`,
    );
  });
});

describe("containerBodies", () => {
  it("saves at the notes tenant unless told otherwise", async () => {
    const r = rig();
    const c = await r.note("c");
    await containerBodies(r.facet).saveBody(c, [{ text: "one" }]);
    expect(r.dial.admits.at(-1)?.scope).toBe("notes");
    expect(await containerBodies(r.facet).readBody(c)).toHaveLength(1);
    await saveContainerBody(r.facet, c, [{ text: "one" }, { text: "two" }]);
    expect(r.dial.admits.at(-1)?.scope).toBe("notes");
  });
});
