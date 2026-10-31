/**
 * The container write and the coarse-save diff, pinned at the contract:
 * what a save returns, what it asks the gate to hold, and what it refuses
 * before anything is minted. Synthetic fixtures only.
 */

import { describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import {
  ChaosClientError,
  type ChaosExpect,
  FixtureChaosDial,
  opCreate,
} from "../src/chaos-client.js";
import {
  bodyDiffOps,
  saveContainerBody,
  sectionsOf,
} from "../src/container-body.js";
import { readContainer, type ContainerBlock } from "../src/container-read.js";
import { writeContainer } from "../src/container-write.js";
import { SlotFactError, textHash } from "../src/slot-facts.js";
import { TREE_CONTENT, readTree } from "../src/tree.js";

async function setup(tenant: "notes" | "documents" = "notes") {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const res = await dial.admit([opCreate("Note", "doc")], tenant);
  const doc = res.minted[0] ?? "";
  return { dial, blobs, doc, facet: { blobs, dial } };
}

/** Record every admit's expectations without changing what it answers. */
function spyExpects(dial: FixtureChaosDial): ChaosExpect[][] {
  const seen: ChaosExpect[][] = [];
  const inner = dial.admit.bind(dial);
  dial.admit = (ops, scope, expects) => {
    seen.push(expects ?? []);
    return inner(ops, scope, expects);
  };
  return seen;
}

const factsOf = async (
  facet: Awaited<ReturnType<typeof setup>>["facet"],
  doc: string,
) => (await readContainer(facet, doc, { facts: true })).blocks[0]?.facts;

describe("a save's result shape", () => {
  it("a netted-out save answers exactly noop/applied/minted/blobIds", async () => {
    const { facet, dial, doc } = await setup();
    await writeContainer(facet, doc, [
      { op: "add", text: "same", position: "a0" },
    ]);
    const [slot] = await readTree(dial, doc);
    const r = await writeContainer(facet, doc, [
      {
        op: "update",
        slot: slot?.slot ?? "",
        oldBlobId: slot?.blobId ?? "",
        text: "same",
      },
    ]);
    expect(r).toEqual({
      noop: true,
      applied: [],
      minted: {},
      blobIds: { 0: slot?.blobId },
    });
  });

  it("a plain save carries no routed or orphaned keys; minted keys the original op index", async () => {
    const { facet, dial, doc } = await setup();
    await writeContainer(facet, doc, [
      { op: "add", text: "x", position: "a0" },
    ]);
    const [s0] = await readTree(dial, doc);
    const r = await writeContainer(facet, doc, [
      {
        op: "reorder",
        slot: s0?.slot ?? "",
        oldPosition: "a0",
        position: "a5",
      },
      { op: "add", text: "y", position: "a9" },
    ]);
    expect(r.noop).toBe(false);
    expect(r.applied).toEqual([0, 1]);
    expect(Object.keys(r.minted)).toEqual(["1"]);
    expect(Object.keys(r.blobIds)).toEqual(["1"]);
    expect(r).not.toHaveProperty("routed");
    expect(r).not.toHaveProperty("orphaned");
  });

  it("the save lands at the named tenant's scope", async () => {
    const { facet, dial, doc } = await setup("documents");
    await writeContainer(
      facet,
      doc,
      [{ op: "add", text: "x", position: "a0" }],
      "documents",
    );
    expect(dial.admits.at(-1)?.scope).toBe("documents");
    await writeContainer(facet, doc, [
      { op: "add", text: "y", position: "a1" },
    ]);
    expect(dial.admits.at(-1)?.scope).toBe("notes");
  });
});

describe("facts are validated before anything is minted", () => {
  it("a disallowed predicate refuses the save with nothing minted or written", async () => {
    const { facet, dial, blobs, doc } = await setup();
    const admits = dial.admits.length;
    await expect(
      writeContainer(facet, doc, [
        { op: "add", text: "ok", position: "a0" },
        {
          op: "add",
          text: "bad",
          position: "a1",
          facts: [{ predicate: "madeUp", literal: "v" }],
        },
      ]),
    ).rejects.toBeInstanceOf(SlotFactError);
    expect(blobs.size).toBe(0);
    expect(dial.admits.length).toBe(admits);
  });

  it("an add may carry facts that ride the same batch", async () => {
    const { facet, doc } = await setup();
    await writeContainer(facet, doc, [
      {
        op: "add",
        text: "born",
        position: "a0",
        facts: [{ predicate: "authorKind", literal: "agent" }],
      },
    ]);
    expect(await factsOf(facet, doc)).toEqual([
      { predicate: "authorKind", form: "literal", value: "agent" },
    ]);
  });
});

describe("an update whose text is unchanged but which carries facts", () => {
  async function held() {
    const ctx = await setup();
    await writeContainer(ctx.facet, ctx.doc, [
      { op: "add", text: "v1", position: "a0" },
    ]);
    const [slot] = await readTree(ctx.dial, ctx.doc);
    return { ...ctx, slot: slot?.slot ?? "", blob: slot?.blobId ?? "" };
  }

  it("lands only the facts: same content, no content CAS, no repoint", async () => {
    const { facet, dial, doc, slot, blob } = await held();
    const seen = spyExpects(dial);
    const r = await writeContainer(facet, doc, [
      {
        op: "update",
        slot,
        oldBlobId: blob,
        text: "v1",
        facts: [{ predicate: "turnsDigest", literal: "0123456789abcdef" }],
      },
    ]);
    expect(r.noop).toBe(false);
    expect(r.applied).toEqual([0]);
    expect(r.blobIds[0]).toBe(blob);
    expect(seen.at(-1)).toEqual([]);
    expect(
      dial.admits.at(-1)?.ops.some((o) => o.predicate === TREE_CONTENT),
    ).toBe(false);
    expect((await readTree(dial, doc))[0]?.blobId).toBe(blob);
    expect(await factsOf(facet, doc)).toEqual([
      { predicate: "turnsDigest", form: "literal", value: "0123456789abcdef" },
    ]);
  });

  it("a real rewrite holds the old blob and a facts-only edit does not", async () => {
    const { facet, dial, doc, slot, blob } = await held();
    const seen = spyExpects(dial);
    await writeContainer(facet, doc, [
      { op: "update", slot, oldBlobId: blob, text: "v2" },
    ]);
    expect(seen.at(-1)).toEqual([
      {
        s: slot,
        predicate: TREE_CONTENT,
        held: [{ $blob: blob }],
      },
    ]);
  });
});

describe("a rewrite replaces the slot's contentHash", () => {
  it("a slot that carries a hash gets the new text's hash, server-side", async () => {
    const { facet, dial, doc } = await setup();
    await writeContainer(facet, doc, [
      {
        op: "add",
        text: "v1",
        position: "a0",
        facts: [{ predicate: "contentHash" }],
      },
    ]);
    const [s] = await readTree(dial, doc);
    expect(await factsOf(facet, doc)).toEqual([
      { predicate: "contentHash", form: "literal", value: textHash("v1") },
    ]);
    await writeContainer(facet, doc, [
      {
        op: "update",
        slot: s?.slot ?? "",
        oldBlobId: s?.blobId ?? "",
        text: "v2",
      },
    ]);
    expect(await factsOf(facet, doc)).toEqual([
      { predicate: "contentHash", form: "literal", value: textHash("v2") },
    ]);
  });

  it("a slot that carries no hash is not given one by an edit", async () => {
    const { facet, dial, doc } = await setup();
    await writeContainer(facet, doc, [
      { op: "add", text: "v1", position: "a0" },
    ]);
    const [s] = await readTree(dial, doc);
    await writeContainer(facet, doc, [
      {
        op: "update",
        slot: s?.slot ?? "",
        oldBlobId: s?.blobId ?? "",
        text: "v2",
      },
    ]);
    expect(await factsOf(facet, doc)).toEqual([]);
  });

  it("a hash sent with the update replaces the held one: one hash, the new text's", async () => {
    const { facet, dial, doc } = await setup();
    await writeContainer(facet, doc, [
      {
        op: "add",
        text: "v1",
        position: "a0",
        facts: [{ predicate: "contentHash" }],
      },
    ]);
    const [s] = await readTree(dial, doc);
    await writeContainer(facet, doc, [
      {
        op: "update",
        slot: s?.slot ?? "",
        oldBlobId: s?.blobId ?? "",
        text: "v2",
        facts: [{ predicate: "contentHash", literal: textHash("v2") }],
      },
    ]);
    expect(await factsOf(facet, doc)).toEqual([
      { predicate: "contentHash", form: "literal", value: textHash("v2") },
    ]);
  });

  it("a hash sent with an unchanged text re-lays the same hash and nets to nothing", async () => {
    const { facet, dial, doc } = await setup();
    await writeContainer(facet, doc, [
      {
        op: "add",
        text: "v1",
        position: "a0",
        facts: [{ predicate: "contentHash" }],
      },
    ]);
    const [s] = await readTree(dial, doc);
    const r = await writeContainer(facet, doc, [
      {
        op: "update",
        slot: s?.slot ?? "",
        oldBlobId: s?.blobId ?? "",
        text: "v1",
        facts: [{ predicate: "contentHash" }],
      },
    ]);
    expect(await factsOf(facet, doc)).toEqual([
      { predicate: "contentHash", form: "literal", value: textHash("v1") },
    ]);
    expect(r.applied).toEqual([0]);
  });
});

describe("a guarded reorder", () => {
  async function two() {
    const ctx = await setup();
    await writeContainer(ctx.facet, ctx.doc, [
      { op: "add", text: "one", position: "a0" },
    ]);
    const [s] = await readTree(ctx.dial, ctx.doc);
    return { ...ctx, slot: s?.slot ?? "" };
  }

  it("holds the position as read; an unguarded one holds nothing", async () => {
    const { facet, dial, doc, slot } = await two();
    const seen = spyExpects(dial);
    await writeContainer(facet, doc, [
      { op: "reorder", slot, oldPosition: "a0", position: "a1", guard: true },
    ]);
    expect(seen.at(-1)).toEqual([
      { s: slot, predicate: "tree_position", held: [{ literal: "a0" }] },
    ]);
    await writeContainer(facet, doc, [
      { op: "reorder", slot, oldPosition: "a1", position: "a2" },
    ]);
    expect(seen.at(-1)).toEqual([]);
  });

  it("a guard that no longer holds refuses as a conflict naming the slot", async () => {
    const { facet, doc, slot } = await two();
    await writeContainer(facet, doc, [
      { op: "reorder", slot, oldPosition: "a0", position: "a1" },
    ]);
    const err = await writeContainer(facet, doc, [
      { op: "reorder", slot, oldPosition: "a0", position: "a2", guard: true },
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChaosClientError);
    expect((err as ChaosClientError).code).toBe("conflict");
    expect((err as ChaosClientError).message).toContain(slot);
  });
});

describe("how a failed admit is reported", () => {
  async function failing(make: () => Error) {
    const { facet, dial, doc } = await setup();
    await writeContainer(facet, doc, [
      { op: "add", text: "a", position: "a0" },
      { op: "add", text: "b", position: "a1" },
    ]);
    const tree = await readTree(dial, doc);
    dial.admit = () => Promise.reject(make());
    const err = await writeContainer(facet, doc, [
      {
        op: "update",
        slot: tree[0]?.slot ?? "",
        oldBlobId: tree[0]?.blobId ?? "",
        text: "a2",
      },
      {
        op: "update",
        slot: tree[1]?.slot ?? "",
        oldBlobId: tree[1]?.blobId ?? "",
        text: "b2",
      },
    ]).catch((e: unknown) => e);
    return { err: err as ChaosClientError, tree };
  }

  it("a conflict names the slot the store pointed at, in calliope's words", async () => {
    const { err, tree } = await failing(
      () => new ChaosClientError("expect[1] s=zz held mismatch", "conflict"),
    );
    expect(err.code).toBe("conflict");
    expect(err.message).toContain(
      `write_container: conflict — slot ${tree[1]?.slot ?? ""} no longer holds`,
    );
    expect(err.message).not.toContain(tree[0]?.slot ?? "");
    expect(err.message).toContain("Nothing was written");
    expect(err.message.endsWith("[expect[1] s=zz held mismatch]")).toBe(true);
  });

  it("an unreadable conflict detail names every slot the batch was conditional on", async () => {
    const { err, tree } = await failing(
      () => new ChaosClientError("something odd", "conflict"),
    );
    expect(err.message).toContain(
      `slot ${tree[0]?.slot ?? ""}, ${tree[1]?.slot ?? ""} no longer holds`,
    );
  });

  it("an index past the expectations also names every slot", async () => {
    const { err, tree } = await failing(
      () => new ChaosClientError("expect[9] s=q", "conflict"),
    );
    expect(err.message).toContain(
      `slot ${tree[0]?.slot ?? ""}, ${tree[1]?.slot ?? ""} no longer holds`,
    );
  });

  it("any other failure passes through untouched", async () => {
    const other = new ChaosClientError("boom", "wire_error");
    const { err } = await failing(() => other);
    expect(err).toBe(other);
    const plain = new Error("plain");
    const { err: err2 } = await failing(() => plain);
    expect(err2).toBe(plain as unknown as ChaosClientError);
  });

  it("a refused batch is admit_refused, with the gate's violations verbatim", async () => {
    const { facet, dial, doc } = await setup();
    dial.refuseWith = [{ check: "shape", detail: "fixture says no" }];
    const err = await writeContainer(facet, doc, [
      { op: "add", text: "x", position: "a0" },
    ]).catch((e: unknown) => e as ChaosClientError);
    expect(err).toBeInstanceOf(ChaosClientError);
    expect((err as ChaosClientError).code).toBe("admit_refused");
    expect((err as ChaosClientError).message).toBe(
      "write_container: the gate refused the batch (minted blobs remain as " +
        "orphans for the census; no tree change landed)",
    );
  });
});

describe("sectionsOf", () => {
  it("maps slot to id, position to orderKey, and a dangling block to empty prose", () => {
    const blocks: ContainerBlock[] = [
      { slot: "s1", position: "p1", blobId: "b", text: "hi", dangling: false },
      { slot: "s2", position: "p2", blobId: null, text: null, dangling: true },
    ];
    expect(sectionsOf(blocks)).toEqual([
      { id: "s1", text: "hi", orderKey: "p1" },
      { id: "s2", text: "", orderKey: "p2" },
    ]);
  });
});

describe("bodyDiffOps edge cases", () => {
  const block = (
    slot: string,
    position: string,
    text: string,
  ): ContainerBlock => ({
    slot,
    position,
    blobId: `blob-${text}`,
    text,
    dangling: false,
  });
  const dangling = (slot: string, position: string): ContainerBlock => ({
    slot,
    position,
    blobId: null,
    text: null,
    dangling: true,
  });

  it("a dangling block in the shared prefix is rewritten with an empty old blob", () => {
    expect(bodyDiffOps([dangling("s1", "1")], [{ text: "now" }])).toEqual([
      { op: "update", slot: "s1", oldBlobId: "", text: "now" },
    ]);
  });

  it("a dangling block wanted as empty prose is already equal", () => {
    expect(bodyDiffOps([dangling("s1", "1")], [{ text: "" }])).toEqual([]);
  });

  it("an empty container takes extras from the floor, in ascending order", () => {
    const ops = bodyDiffOps([], [{ text: "a" }, { text: "b" }]);
    expect(ops).toHaveLength(2);
    const [p0 = "", p1 = ""] = ops.map((o) =>
      o.op === "add" ? o.position : "",
    );
    expect(p0).not.toBe("");
    expect(p1 > p0).toBe(true);
    expect(ops.map((o) => (o.op === "add" ? o.text : ""))).toEqual(["a", "b"]);
  });

  it("keys that would outgrow the cap re-lay the kept blocks, guarded, in the same diff", () => {
    const ops = bodyDiffOps(
      [block("s1", "01", "a"), block("s2", "9999", "b")],
      [{ text: "a" }, { text: "b" }, { text: "c" }],
    );
    expect(ops).toEqual([
      {
        op: "reorder",
        slot: "s2",
        oldPosition: "9999",
        position: "02",
        guard: true,
      },
      { op: "add", text: "c", position: "03" },
    ]);
  });

  it("a re-lay moves every kept block whose key changes, in order", () => {
    const ops = bodyDiffOps(
      [block("s1", "5", "a"), block("s2", "9999", "b")],
      [{ text: "a" }, { text: "b" }, { text: "c" }],
    );
    expect(ops.map((o) => o.op)).toEqual(["reorder", "reorder", "add"]);
    expect(ops[0]).toEqual({
      op: "reorder",
      slot: "s1",
      oldPosition: "5",
      position: "01",
      guard: true,
    });
  });

  it("removes only blocks past the shared prefix, carrying their position", () => {
    const ops = bodyDiffOps(
      [block("s1", "1", "a"), block("s2", "2", "b"), dangling("s3", "3")],
      [{ text: "a" }],
    );
    expect(ops).toEqual([
      { op: "remove", slot: "s2", position: "2", blobId: "blob-b" },
    ]);
  });
});

describe("saveContainerBody", () => {
  it("writes at the notes tenant by default and the named tenant when given", async () => {
    const { facet, dial, doc } = await setup("documents");
    await saveContainerBody(facet, doc, [{ text: "one" }]);
    expect(dial.admits.at(-1)?.scope).toBe("notes");
    await saveContainerBody(
      facet,
      doc,
      [{ text: "one" }, { text: "two" }],
      "documents",
    );
    expect(dial.admits.at(-1)?.scope).toBe("documents");
  });

  it("a save that diffs to nothing opens no transaction", async () => {
    const { facet, dial, doc } = await setup();
    await saveContainerBody(facet, doc, [{ text: "one" }]);
    const n = dial.admits.length;
    await saveContainerBody(facet, doc, [{ text: "one" }]);
    expect(dial.admits.length).toBe(n);
  });
});
