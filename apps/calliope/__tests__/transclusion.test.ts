/**
 * Slot-to-slot transclusion (Lamarr37-002): a placement slot references an
 * origin slot; reads resolve through it; an edit through any placement
 * rewrites the origin, CAS on the origin's blob.
 */

import { describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import {
  ChaosClientError,
  FixtureChaosDial,
  type Tenant,
  opAdd,
  opCreate,
} from "../src/chaos-client.js";
import {
  containerHistory,
  readContainer,
  readContainers,
} from "../src/container-read.js";
import {
  type ContainerFacet,
  type ContainerOp,
  writeContainer,
} from "../src/container-write.js";
import { allowAllPlacements } from "../src/placement-policy.js";
import {
  PlacementError,
  orphanedPlacements,
  placementsOf,
} from "../src/transclusion.js";
import { TREE_REF, readTree } from "../src/tree.js";

function rig(facetExtra: Partial<ContainerFacet> = {}) {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const facet: ContainerFacet = { blobs, dial, ...facetExtra };
  const note = async (label: string, tenant: Tenant = "notes") => {
    const res = await dial.admit([opCreate("Note", label)], tenant);
    const token = res.minted[0];
    if (token === undefined) throw new Error("fixture minted nothing");
    return token;
  };
  /** A container with one block of `text`; answers [container, slot]. */
  const withBlock = async (
    label: string,
    text: string,
    tenant: Tenant = "notes",
  ): Promise<[string, string]> => {
    const c = await note(label, tenant);
    const w = await writeContainer(
      facet,
      c,
      [{ op: "add", text, position: "a0" }],
      tenant,
    );
    const slot = w.minted[0];
    if (slot === undefined) throw new Error("no slot minted");
    return [c, slot];
  };
  /** Place `origin` in `container`; answers the placement slot. */
  const place = async (
    container: string,
    origin: string,
    position = "b0",
    tenant: Tenant = "notes",
  ): Promise<string> => {
    const w = await writeContainer(
      facet,
      container,
      [{ op: "add", ref: origin, position }],
      tenant,
    );
    const slot = w.minted[0];
    if (slot === undefined) throw new Error("no placement minted");
    return slot;
  };
  const block = async (container: string, slot: string) => {
    const b = (await readContainer(facet, container)).blocks.find(
      (x) => x.slot === slot,
    );
    if (b === undefined) throw new Error(`no block ${slot}`);
    return b;
  };
  return { dial, blobs, facet, note, withBlock, place, block };
}

async function refusal(p: Promise<unknown>): Promise<PlacementError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PlacementError);
  return err as PlacementError;
}

describe("a placement resolves through its origin", () => {
  it("reads the origin's blob and text, with ref naming slot and container", async () => {
    const r = rig();
    const [a, origin] = await r.withBlock("a", "shared block");
    const b = await r.note("b");
    const p = await r.place(b, origin);
    const got = await r.block(b, p);
    const src = await r.block(a, origin);
    expect(got.text).toBe("shared block");
    expect(got.blobId).toBe(src.blobId);
    expect(got.dangling).toBe(false);
    expect(got.ref).toEqual({ slot: origin, container: a });
    // A blob slot's block is unchanged in shape: no ref, no placements.
    expect(src).not.toHaveProperty("ref");
    expect(src).not.toHaveProperty("placements");
  });

  it("an add with ref mints no blob", async () => {
    const r = rig();
    const [, origin] = await r.withBlock("a", "only once");
    const before = r.blobs.size;
    await r.place(await r.note("b"), origin);
    expect(r.blobs.size).toBe(before);
  });

  it("read_containers resolves too, and the revision moves on an origin edit", async () => {
    const r = rig();
    const [a, origin] = await r.withBlock("a", "v1");
    const b = await r.note("b");
    const p = await r.place(b, origin);
    const one = await readContainers(r.facet, [b], { texts: true });
    expect(one.containers[0]?.blocks[0]?.text).toBe("v1");
    expect(one.containers[0]?.blocks[0]?.ref?.slot).toBe(origin);
    const src = await r.block(a, origin);
    await writeContainer(r.facet, a, [
      { op: "update", slot: origin, oldBlobId: src.blobId ?? "", text: "v2" },
    ]);
    const two = await readContainers(r.facet, [b], { texts: true });
    expect(two.containers[0]?.blocks[0]?.text).toBe("v2");
    expect(two.containers[0]?.revision).not.toBe(one.containers[0]?.revision);
    expect(two.containers[0]?.blocks[0]?.slot).toBe(p);
  });
});

describe("edits through a placement land on the origin (all three change)", () => {
  it("an update through one placement changes the origin and every placement", async () => {
    const r = rig();
    const [a, origin] = await r.withBlock("a", "before");
    const b = await r.note("b");
    const c = await r.note("c");
    const pb = await r.place(b, origin);
    const pc = await r.place(c, origin);
    const seen = await r.block(b, pb);
    const w = await writeContainer(r.facet, b, [
      { op: "update", slot: pb, oldBlobId: seen.blobId ?? "", text: "after" },
    ]);
    expect(w.routed).toEqual({ 0: origin });
    expect((await r.block(a, origin)).text).toBe("after");
    expect((await r.block(b, pb)).text).toBe("after");
    expect((await r.block(c, pc)).text).toBe("after");
    // The placement is still a placement: no blob fact landed on it.
    expect((await readTree(r.dial, b))[0]?.blobId).toBeNull();
    expect((await readTree(r.dial, b))[0]?.ref).toBe(origin);
  });

  it("concurrent edits through two placements: exactly one wins, the other conflicts", async () => {
    const r = rig();
    const [a, origin] = await r.withBlock("a", "base");
    const b = await r.note("b");
    const c = await r.note("c");
    const pb = await r.place(b, origin);
    const pc = await r.place(c, origin);
    const base = (await r.block(b, pb)).blobId ?? "";
    const results = await Promise.allSettled([
      writeContainer(r.facet, b, [
        { op: "update", slot: pb, oldBlobId: base, text: "from b" },
      ]),
      writeContainer(r.facet, c, [
        { op: "update", slot: pc, oldBlobId: base, text: "from c" },
      ]),
    ]);
    const won = results.filter((x) => x.status === "fulfilled");
    const lost = results.filter((x) => x.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const first = lost[0];
    if (first?.status !== "rejected") throw new Error("no rejection");
    const reason: unknown = first.reason;
    expect(reason).toBeInstanceOf(ChaosClientError);
    expect((reason as ChaosClientError).code).toBe("conflict");
    const text = (await r.block(a, origin)).text;
    expect(["from b", "from c"]).toContain(text);
  });

  it("a stale oldBlobId through a placement is a conflict, nothing written", async () => {
    const r = rig();
    const [a, origin] = await r.withBlock("a", "one");
    const b = await r.note("b");
    const p = await r.place(b, origin);
    const stale = (await r.block(a, origin)).blobId ?? "";
    await writeContainer(r.facet, a, [
      { op: "update", slot: origin, oldBlobId: stale, text: "two" },
    ]);
    const err = await writeContainer(r.facet, b, [
      { op: "update", slot: p, oldBlobId: stale, text: "three" },
    ]).catch((e: unknown) => e);
    expect((err as ChaosClientError).code).toBe("conflict");
    expect((await r.block(a, origin)).text).toBe("two");
  });

  it("two ops rewriting one origin in one save are refused bad_args", async () => {
    const r = rig();
    const [a, origin] = await r.withBlock("a", "x");
    const p = await r.place(a, origin, "b0");
    const blob = (await r.block(a, origin)).blobId ?? "";
    const err = await refusal(
      writeContainer(r.facet, a, [
        { op: "update", slot: origin, oldBlobId: blob, text: "y" },
        { op: "update", slot: p, oldBlobId: blob, text: "z" },
      ]),
    );
    expect(err.code).toBe("bad_args");
  });

  it("an edit through a placement carries no slot facts but contentHash", async () => {
    const r = rig();
    const [, origin] = await r.withBlock("a", "x");
    const b = await r.note("b");
    const p = await r.place(b, origin);
    const blob = (await r.block(b, p)).blobId ?? "";
    const err = await refusal(
      writeContainer(r.facet, b, [
        {
          op: "update",
          slot: p,
          oldBlobId: blob,
          text: "y",
          facts: [{ predicate: "links", literal: "https://x" }],
        },
      ]),
    );
    expect(err.code).toBe("bad_args");
  });
});

describe("coincidental identical blobs stay independent (identity is the slot)", () => {
  it("editing through a placement rewrites only the placed slot, never the twin", async () => {
    const r = rig();
    const [a, origin] = await r.withBlock("a", "TODO: verify");
    const [t, twin] = await r.withBlock("twin", "TODO: verify");
    // Content-addressed: both slots hold the SAME blob by coincidence.
    expect((await r.block(a, origin)).blobId).toBe(
      (await r.block(t, twin)).blobId,
    );
    const b = await r.note("b");
    const p = await r.place(b, origin);
    const blob = (await r.block(b, p)).blobId ?? "";
    await writeContainer(r.facet, b, [
      { op: "update", slot: p, oldBlobId: blob, text: "verified" },
    ]);
    expect((await r.block(a, origin)).text).toBe("verified");
    expect((await r.block(t, twin)).text).toBe("TODO: verify");
    // The twin has no placements; the origin has exactly one.
    expect(await placementsOf(r.dial, twin)).toEqual([]);
    expect(await placementsOf(r.dial, origin)).toEqual([
      { slot: p, container: b },
    ]);
  });
});

describe("chains and cycles", () => {
  it("chain: a ref to a placement is refused bad_args (one hop only)", async () => {
    const r = rig();
    const [, origin] = await r.withBlock("a", "x");
    const b = await r.note("b");
    const p = await r.place(b, origin);
    const c = await r.note("c");
    const err = await refusal(
      writeContainer(r.facet, c, [{ op: "add", ref: p, position: "a0" }]),
    );
    expect(err.code).toBe("bad_args");
    expect(err.message).toContain(origin);
    expect(await readTree(r.dial, c)).toEqual([]);
  });

  it("cycle: a planted A→B→A loop reads dangling and terminates", async () => {
    const r = rig();
    const c = await r.note("c");
    // Written around the verb, as only corrupt data could be.
    const res = await r.dial.admit(
      [
        opCreate("Block", "x"),
        opCreate("Block", "y"),
        opAdd(c, "tree_member", { toNode: "x" }),
        opAdd("x", "tree_position", { toLiteral: "a0" }),
        opAdd("x", TREE_REF, { toNode: "y" }),
        opAdd(c, "tree_member", { toNode: "y" }),
        opAdd("y", "tree_position", { toLiteral: "a1" }),
        opAdd("y", TREE_REF, { toNode: "x" }),
      ],
      "notes",
    );
    const [x, y] = res.minted;
    const read = await readContainer(r.facet, c);
    expect(read.blocks.map((b) => [b.slot, b.dangling, b.ref?.slot])).toEqual([
      [x, true, y],
      [y, true, x],
    ]);
    // And neither may be placed: each is itself a placement.
    const err = await refusal(
      writeContainer(r.facet, c, [{ op: "add", ref: x ?? "", position: "a2" }]),
    );
    expect(err.code).toBe("bad_args");
  });

  it("chain: a planted ref to a slot that is itself a placement is not followed", async () => {
    const r = rig();
    const [, origin] = await r.withBlock("a", "deep");
    const c = await r.note("c");
    // q holds content AND a ref (only corrupt data could); p places q.
    const res = await r.dial.admit(
      [
        opCreate("Block", "q"),
        opAdd("q", "tree_content", { toBlob: await r.blobs.mint("q text") }),
        opAdd("q", TREE_REF, { toNode: origin }),
        opCreate("Block", "p"),
        opAdd(c, "tree_member", { toNode: "p" }),
        opAdd("p", "tree_position", { toLiteral: "a0" }),
        opAdd("p", TREE_REF, { toNode: "q" }),
      ],
      "notes",
    );
    const read = await readContainer(r.facet, c);
    expect(read.blocks.map((b) => [b.slot, b.dangling, b.text])).toEqual([
      [res.minted[1], true, null],
    ]);
  });

  it("a ref to no slot is refused not_found; a malformed ref bad_args", async () => {
    const r = rig();
    const b = await r.note("b");
    expect(
      (
        await refusal(
          writeContainer(r.facet, b, [
            { op: "add", ref: "ab".repeat(32), position: "a0" },
          ]),
        )
      ).code,
    ).toBe("not_found");
    expect(
      (
        await refusal(
          writeContainer(r.facet, b, [
            { op: "add", ref: "nope", position: "a0" },
          ]),
        )
      ).code,
    ).toBe("bad_args");
  });
});

describe("removing a placement vs removing an origin", () => {
  it("removing a placement leaves the origin and other placements alone", async () => {
    const r = rig();
    const [a, origin] = await r.withBlock("a", "kept");
    const b = await r.note("b");
    const p = await r.place(b, origin);
    const got = await r.block(b, p);
    await writeContainer(r.facet, b, [
      {
        op: "remove",
        slot: p,
        position: got.position,
        blobId: got.blobId ?? "",
      },
    ]);
    expect((await readContainer(r.facet, b)).blocks).toEqual([]);
    expect((await r.block(a, origin)).text).toBe("kept");
    expect(await placementsOf(r.dial, origin)).toEqual([]);
  });

  it("removing an origin with live placements is refused has_placements", async () => {
    const r = rig();
    const [a, origin] = await r.withBlock("a", "precious");
    await r.place(await r.note("b"), origin);
    const src = await r.block(a, origin);
    const err = await refusal(
      writeContainer(r.facet, a, [
        {
          op: "remove",
          slot: origin,
          position: src.position,
          blobId: src.blobId ?? "",
        },
      ]),
    );
    expect(err.code).toBe("has_placements");
    expect((await r.block(a, origin)).text).toBe("precious");
  });

  it('placements: "orphan" removes the origin; the placement dangles with ref kept (dangling)', async () => {
    const r = rig();
    const [a, origin] = await r.withBlock("a", "going");
    const b = await r.note("b");
    const p = await r.place(b, origin);
    const src = await r.block(a, origin);
    const w = await writeContainer(r.facet, a, [
      {
        op: "remove",
        slot: origin,
        position: src.position,
        blobId: src.blobId ?? "",
        placements: "orphan",
      },
    ]);
    expect(w.orphaned).toEqual([{ slot: p, container: b, origin }]);
    const got = await r.block(b, p);
    expect(got.dangling).toBe(true);
    expect(got.text).toBeNull();
    expect(got.blobId).toBeNull();
    expect(got.ref?.slot).toBe(origin);
    // The detector, callable on its own, finds the same orphan.
    expect(await orphanedPlacements(r.dial, [origin])).toEqual([
      { slot: p, container: b, origin },
    ]);
    // A dangling placement is removed with blobId "".
    await writeContainer(r.facet, b, [
      { op: "remove", slot: p, position: got.position, blobId: "" },
    ]);
    expect((await readContainer(r.facet, b)).blocks).toEqual([]);
  });

  it("an origin removed together with its only placement needs no orphan flag", async () => {
    const r = rig();
    const [a, origin] = await r.withBlock("a", "both");
    const p = await r.place(a, origin, "b0");
    const blocks = (await readContainer(r.facet, a)).blocks;
    const ops: ContainerOp[] = blocks.map((b) => ({
      op: "remove",
      slot: b.slot,
      position: b.position,
      blobId: b.blobId ?? "",
    }));
    const w = await writeContainer(r.facet, a, ops);
    expect(w.orphaned).toBeUndefined();
    expect(await readTree(r.dial, a)).toEqual([]);
    expect(p).toBeDefined();
  });
});

describe("as_of_tx and history", () => {
  it("as_of_tx resolves a placement as of that transaction", async () => {
    const r = rig();
    const [a, origin] = await r.withBlock("a", "old");
    const b = await r.note("b");
    const p = await r.place(b, origin);
    const then = r.dial.factLog.at(-1)?.tx ?? 0;
    const blob = (await r.block(a, origin)).blobId ?? "";
    await writeContainer(r.facet, a, [
      { op: "update", slot: origin, oldBlobId: blob, text: "new" },
    ]);
    const past = await readContainer(r.facet, b, { asOfTx: then });
    expect(past.blocks.map((x) => [x.slot, x.text, x.ref?.slot])).toEqual([
      [p, "old", origin],
    ]);
    expect((await r.block(b, p)).text).toBe("new");
  });

  it("container_history lists edits made at the origin", async () => {
    const r = rig();
    const [a, origin] = await r.withBlock("a", "h1");
    const b = await r.note("b");
    await r.place(b, origin);
    const blob = (await r.block(a, origin)).blobId ?? "";
    const w = await writeContainer(r.facet, a, [
      { op: "update", slot: origin, oldBlobId: blob, text: "h2" },
    ]);
    const txs = (await containerHistory(r.facet, b)).map((h) => h.tx);
    expect(txs).toContain(w.tx);
    expect([...txs].sort((x, y) => x - y)).toEqual(txs);
  });
});

describe("the placements reverse index", () => {
  it("a placements read lists each placing slot and its container", async () => {
    const r = rig();
    const [a, origin] = await r.withBlock("a", "src");
    const b = await r.note("b");
    const c = await r.note("c");
    const pb = await r.place(b, origin);
    const pc = await r.place(c, origin);
    const read = await readContainer(r.facet, a, { placements: true });
    expect(read.blocks[0]?.placements).toEqual(
      [
        { slot: pb, container: b },
        { slot: pc, container: c },
      ].sort((x, y) => (x.slot < y.slot ? -1 : 1)),
    );
  });
});

describe("cross-tenant references (ruling 5: the doorway, default closed)", () => {
  it("the default policy refuses a cross-tenant placement", async () => {
    const r = rig();
    const [, origin] = await r.withBlock("memo", "a notes block");
    const law = await r.note("law", "governance");
    const err = await refusal(
      writeContainer(
        r.facet,
        law,
        [{ op: "add", ref: origin, position: "a0" }],
        "governance",
      ),
    );
    expect(err.code).toBe("cross_tenant_placement");
    expect(await readTree(r.dial, law)).toEqual([]);
  });

  it("with the policy open: place, resolve, and edit through it in the origin's tenant", async () => {
    const r = rig({ placementPolicy: allowAllPlacements });
    const [memo, origin] = await r.withBlock("memo", "notes prose");
    const law = await r.note("law", "governance");
    const p = await r.place(law, origin, "a0", "governance");
    const got = await r.block(law, p);
    expect(got.text).toBe("notes prose");
    expect(got.ref).toEqual({ slot: origin, container: memo });
    await writeContainer(
      r.facet,
      law,
      [{ op: "update", slot: p, oldBlobId: got.blobId ?? "", text: "edited" }],
      "governance",
    );
    // The repoint admitted in the ORIGIN's scope, not the placement's.
    expect(r.dial.admits.at(-1)?.scope).toBe("notes");
    expect((await r.block(memo, origin)).text).toBe("edited");
    const placed = r.dial.factLog.filter((f) => f.predicate === TREE_REF);
    expect(placed.every((f) => f.graph !== "")).toBe(true);
  });

  it("a save spanning two tenants is refused bad_args, nothing written", async () => {
    const r = rig({ placementPolicy: allowAllPlacements });
    const [, origin] = await r.withBlock("memo", "x");
    const law = await r.note("law", "governance");
    const p = await r.place(law, origin, "a0", "governance");
    const blob = (await r.block(law, p)).blobId ?? "";
    const before = r.dial.admits.length;
    const err = await refusal(
      writeContainer(
        r.facet,
        law,
        [
          { op: "update", slot: p, oldBlobId: blob, text: "y" },
          { op: "add", text: "a governance line", position: "b0" },
        ],
        "governance",
      ),
    );
    expect(err.code).toBe("bad_args");
    expect(r.dial.admits.length).toBe(before);
  });
});
