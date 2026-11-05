/**
 * The container reads, pinned where the behaviour tests stop: what each
 * read asks the dial for (predicates, subjects, scalar hashes, round-trip
 * counts), how a slot with odd or missing facts is shaped, the as-of read's
 * order and fallback keys, the batch read's frontmatter-only and dangling
 * rules, the revision's exact digest and the history's origin merge.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import {
  type ChaosOp,
  FixtureChaosDial,
  type HistoryEntry,
  opAdd,
  opCreate,
  opRemove,
  scopeHash,
} from "../src/chaos-client.js";
import {
  containerHistory,
  readContainer,
  readContainers,
} from "../src/container-read.js";
import { writeContainer } from "../src/container-write.js";
import { SLOT_FACT_PREDICATES } from "../src/slot-facts.js";
import {
  TREE_CONTENT,
  TREE_MEMBER,
  TREE_POSITION,
  TREE_REF,
  readTree,
} from "../src/tree.js";

const FALLBACK = "￿";
const BASE_PREDICATES = [TREE_POSITION, TREE_CONTENT, TREE_REF];

type Quads = ReturnType<FixtureChaosDial["quadsFrom"]>;
type Scalars = ReturnType<FixtureChaosDial["resolveScalars"]>;
type History = ReturnType<FixtureChaosDial["history"]>;

/** Records what each read asks of the dial; can withhold scalar values and
 *  answer a scripted history. */
class Spy extends FixtureChaosDial {
  quads: {
    subjects: string[];
    asOf: number | null;
    preds: string[] | null;
  }[] = [];
  scalars: string[][] = [];
  histories: { subjects: string[]; follow: string[] }[] = [];
  referred: string[] = [];
  unresolvable = false;
  historyStub: ((subjects: string[]) => HistoryEntry[]) | null = null;

  override quadsFrom(
    subjects: string[],
    asOfTx: number | null,
    predicateNames: string[] | null,
    graph?: string,
  ): Quads {
    this.quads.push({
      subjects: [...subjects],
      asOf: asOfTx,
      preds: predicateNames === null ? null : [...predicateNames],
    });
    return super.quadsFrom(subjects, asOfTx, predicateNames, graph);
  }
  override resolveScalars(hashes: string[]): Scalars {
    this.scalars.push([...hashes]);
    return this.unresolvable
      ? Promise.resolve({})
      : super.resolveScalars(hashes);
  }
  override history(
    subjects: string[],
    follow: string[],
    graph?: string,
  ): History {
    this.histories.push({ subjects: [...subjects], follow: [...follow] });
    return this.historyStub === null
      ? super.history(subjects, follow, graph)
      : Promise.resolve(this.historyStub(subjects));
  }
  override referrers(token: string): ReturnType<FixtureChaosDial["referrers"]> {
    this.referred.push(token);
    return super.referrers(token);
  }
  reset(): void {
    this.quads = [];
    this.scalars = [];
    this.histories = [];
    this.referred = [];
  }
}

/** A store that answers a text for ANY id (null included) and records the
 *  ids it was asked about: a read must never lean on the store to say no. */
class Everywhere extends FixtureBlobStore {
  fetched: string[][] = [];
  override getTexts(ids: string[]): Promise<Map<string, string>> {
    this.fetched.push([...ids]);
    const all = new Map<string, string>();
    all.get = () => "x";
    return Promise.resolve(all);
  }
}

function rig(blobs: FixtureBlobStore = new FixtureBlobStore()) {
  const dial = new Spy();
  const facet = { dial, blobs };
  const mint = async (label: string): Promise<string> =>
    (await dial.admit([opCreate("Note", label)], "notes")).minted[0] ?? "";
  const lastTx = (): number => dial.factLog.at(-1)?.tx ?? 0;
  /** A slot held by `container` with whatever facts `shape` gives it. */
  const odd = async (
    container: string,
    label: string,
    shape: (s: string) => ChaosOp[],
  ): Promise<string> => {
    const res = await dial.admit(
      [
        opCreate("Block", label),
        opAdd(container, TREE_MEMBER, { toNode: label }),
        ...shape(label),
      ],
      "notes",
    );
    return res.minted[0] ?? "";
  };
  const place = async (container: string, origin: string, position = "z") =>
    (
      await writeContainer(facet, container, [
        { op: "add", ref: origin, position },
      ])
    ).minted[0] ?? "";
  return { dial, blobs, facet, mint, lastTx, odd, place };
}

const sha = (v: unknown): string =>
  createHash("sha256").update(JSON.stringify(v), "utf8").digest("hex");
const sorted = (xs: string[]): string[] => [...xs].sort();

describe("the as-of read", () => {
  it("orders by the position facts, resolving exactly the position hashes", async () => {
    const { dial, facet, mint, lastTx } = rig();
    const c = await mint("c");
    await writeContainer(facet, c, [
      { op: "add", text: "late", position: "b" },
      { op: "add", text: "early", position: "a" },
    ]);
    const tx = lastTx();
    const tree = await readTree(dial, c);
    const tokens = tree.map((s) => s.slot);
    // The fixture mints in op order: the fallback (slot token) order is the
    // REVERSE of the position order, so only a resolved position sorts right.
    expect(tokens[0] ?? "").toBe(sorted(tokens)[1]);

    dial.reset();
    const read = await readContainer(facet, c, { asOfTx: tx });
    expect(read.asOfTx).toBe(tx);
    expect(read.blocks.map((b) => [b.text, b.position])).toEqual([
      ["early", "a"],
      ["late", "b"],
    ]);
    expect(read.blocks[0]).not.toHaveProperty("facts");
    expect(dial.quads.map((q) => q.preds)).toEqual([
      [TREE_MEMBER],
      BASE_PREDICATES,
    ]);
    expect(dial.scalars).toHaveLength(1);
    expect(sorted(dial.scalars[0] ?? [])).toEqual(
      sorted([scopeHash("a"), scopeHash("b")]),
    );
  });

  it("with facts, asks for the fact predicates and resolves their values too", async () => {
    const { dial, facet, mint, lastTx } = rig();
    const c = await mint("c");
    await writeContainer(facet, c, [
      {
        op: "add",
        text: "t",
        position: "a",
        facts: [{ predicate: "authorKind", literal: "ai" }],
      },
    ]);
    dial.reset();
    const read = await readContainer(facet, c, {
      asOfTx: lastTx(),
      facts: true,
    });
    expect(read.blocks[0]?.facts).toEqual([
      { predicate: "authorKind", form: "literal", value: "ai" },
    ]);
    expect(dial.quads[1]?.preds).toEqual([
      ...BASE_PREDICATES,
      ...SLOT_FACT_PREDICATES,
    ]);
    expect(sorted(dial.scalars[0] ?? [])).toEqual(
      sorted([scopeHash("a"), scopeHash("ai")]),
    );
  });

  it("asks nothing further of an empty container", async () => {
    const { dial, facet, mint, lastTx } = rig();
    const c = await mint("empty");
    dial.reset();
    expect(
      (await readContainer(facet, c, { asOfTx: lastTx() })).blocks,
    ).toEqual([]);
    expect(dial.quads).toHaveLength(1);
    expect(dial.scalars).toHaveLength(0);
  });

  it("does not take a blob-valued membership for a slot", async () => {
    const { dial, facet, mint, lastTx } = rig();
    const c = await mint("c");
    await writeContainer(facet, c, [{ op: "add", text: "one", position: "a" }]);
    await dial.admit([opAdd(c, TREE_MEMBER, { toBlob: "777" })], "notes");
    const real = (await readTree(dial, c)).map((s) => s.slot);
    dial.reset();
    const read = await readContainer(facet, c, { asOfTx: lastTx() });
    expect(read.blocks.map((b) => b.slot)).toEqual(real);
    expect(dial.quads[1]?.subjects).toEqual(real);
  });

  it("a slot with no position sorts last under the fallback key", async () => {
    const { dial, facet, mint, lastTx } = rig();
    const c = await mint("c");
    await writeContainer(facet, c, [
      { op: "add", text: "keeps", position: "b" },
      { op: "add", text: "loses", position: "a" },
    ]);
    const lost = (await readTree(dial, c)).find((s) => s.position === "a");
    await dial.admit(
      [opRemove(lost?.slot ?? "", TREE_POSITION, { toLiteral: "a" })],
      "notes",
    );
    const read = await readContainer(facet, c, { asOfTx: lastTx() });
    expect(read.blocks.map((b) => [b.text, b.position])).toEqual([
      ["keeps", "b"],
      ["loses", FALLBACK + (lost?.slot ?? "")],
    ]);
  });

  it("a position the dial cannot resolve falls back to the slot token", async () => {
    const { dial, facet, mint, lastTx } = rig();
    const c = await mint("c");
    await writeContainer(facet, c, [
      { op: "add", text: "p", position: "b" },
      { op: "add", text: "q", position: "a" },
    ]);
    dial.unresolvable = true;
    const read = await readContainer(facet, c, { asOfTx: lastTx() });
    const slots = read.blocks.map((b) => b.slot);
    expect(slots).toEqual(sorted(slots));
    expect(read.blocks.map((b) => b.position)).toEqual(
      slots.map((s) => FALLBACK + s),
    );
  });

  it("ignores position, content and ref facts of the wrong form", async () => {
    const { dial, facet, mint, lastTx, odd } = rig();
    const c = await mint("c");
    const w = await odd(c, "weird", (s) => [
      opAdd(s, TREE_POSITION, { toBlob: "5" }),
      opAdd(s, TREE_CONTENT, { toLiteral: "zzz" }),
      opAdd(s, TREE_REF, { toBlob: "9" }),
    ]);
    dial.reset();
    const read = await readContainer(facet, c, { asOfTx: lastTx() });
    expect(read.blocks).toStrictEqual([
      {
        slot: w,
        position: FALLBACK + w,
        blobId: null,
        text: null,
        dangling: true,
      },
    ]);
    expect(dial.scalars[0]).toEqual([]);
  });
});

describe("a placement in the reads", () => {
  async function placed() {
    const r = rig();
    const a = await r.mint("a");
    const origin =
      (
        await writeContainer(r.facet, a, [
          { op: "add", text: "shared", position: "a0" },
        ])
      ).minted[0] ?? "";
    const b = await r.mint("b");
    const p = await r.place(b, origin);
    return { ...r, a, b, origin, p };
  }

  it("names its origin's container at HEAD and never on an as-of read", async () => {
    const r = await placed();
    r.dial.reset();
    const head = await readContainer(r.facet, r.b);
    expect(head.blocks[0]?.ref).toStrictEqual({
      slot: r.origin,
      container: r.a,
    });
    expect(r.dial.referred).toEqual([r.origin]);

    r.dial.reset();
    const past = await readContainer(r.facet, r.b, { asOfTx: r.lastTx() });
    expect(past.blocks[0]?.ref).toStrictEqual({ slot: r.origin });
    expect(past.blocks[0]?.text).toBe("shared");
    expect(r.dial.referred).toEqual([]);
  });

  it("asks no origin's home for a container that places nothing", async () => {
    const r = await placed();
    r.dial.reset();
    await readContainer(r.facet, r.a);
    expect(r.dial.referred).toEqual([]);
  });

  it("gives only the origin slot when no container holds it", async () => {
    const r = await placed();
    await r.dial.admit(
      [opRemove(r.a, TREE_MEMBER, { toNode: r.origin })],
      "notes",
    );
    const head = await readContainer(r.facet, r.b);
    expect(head.blocks[0]?.ref).toStrictEqual({ slot: r.origin });
    const batch = await readContainers(r.facet, [r.b], { texts: true });
    expect(batch.containers[0]?.blocks[0]?.ref).toStrictEqual({
      slot: r.origin,
    });
  });
});

describe("assembling blocks", () => {
  it("fetches only the blob ids that exist and never invents a text", async () => {
    const blobs = new Everywhere();
    const { facet, mint, odd } = rig(blobs);
    const c = await mint("c");
    await writeContainer(facet, c, [
      { op: "add", text: "real", position: "a" },
    ]);
    const bare = await odd(c, "bare", (s) => [
      opAdd(s, TREE_POSITION, { toLiteral: "b" }),
    ]);
    const real = (await readTree(facet.dial, c)).find((s) => s.slot !== bare);
    blobs.fetched = [];
    const read = await readContainer(facet, c);
    expect(blobs.fetched).toEqual([[real?.blobId]]);
    expect(read.blocks.map((b) => [b.text, b.dangling, b.blobId])).toEqual([
      ["x", false, real?.blobId],
      [null, true, null],
    ]);
  });
});

describe("the batch read", () => {
  it("answers a frontmatter-only container, empty and not missing", async () => {
    const { dial, facet, mint } = rig();
    const f = await mint("f");
    await dial.admit(
      [opAdd(f, "frontmatter", { toLiteral: "title: t" })],
      "notes",
    );
    for (const facts of [false, true]) {
      dial.reset();
      const out = await readContainers(facet, [f], { texts: true, facts });
      expect(out.missing).toEqual([]);
      expect(out.containers).toEqual([
        {
          container: f,
          revision: sha([[], "title: t"]),
          frontmatter: "title: t",
          blocks: [],
        },
      ]);
      expect(dial.quads).toHaveLength(1);
    }
  });

  it("asks for exactly the tree predicates, the facts' only on request", async () => {
    const { dial, facet, mint } = rig();
    const c = await mint("c");
    await writeContainer(facet, c, [
      {
        op: "add",
        text: "t",
        position: "a",
        facts: [{ predicate: "authorKind", literal: "ai" }],
      },
    ]);
    dial.reset();
    const plain = await readContainers(facet, [c], { texts: true });
    expect(dial.quads.map((q) => q.preds)).toEqual([
      [TREE_MEMBER, "frontmatter"],
      BASE_PREDICATES,
    ]);
    expect(dial.scalars).toEqual([[scopeHash("a")]]);
    expect(plain.containers[0]?.blocks[0]).not.toHaveProperty("facts");

    dial.reset();
    const withFacts = await readContainers(facet, [c], {
      texts: true,
      facts: true,
    });
    expect(dial.quads[1]?.preds).toEqual([
      ...BASE_PREDICATES,
      ...SLOT_FACT_PREDICATES,
    ]);
    expect(sorted(dial.scalars[0] ?? [])).toEqual(
      sorted([scopeHash("a"), scopeHash("ai")]),
    );
    expect(withFacts.containers[0]?.blocks[0]?.facts).toEqual([
      { predicate: "authorKind", form: "literal", value: "ai" },
    ]);
  });

  it("does not take a blob-valued membership for a slot", async () => {
    const { dial, facet, mint } = rig();
    const c = await mint("c");
    await writeContainer(facet, c, [{ op: "add", text: "one", position: "a" }]);
    await dial.admit([opAdd(c, TREE_MEMBER, { toBlob: "777" })], "notes");
    const real = (await readTree(dial, c)).map((s) => s.slot);
    dial.reset();
    const out = await readContainers(facet, [c], { texts: true });
    expect(out.containers[0]?.blocks.map((b) => b.slot)).toEqual(real);
    expect(dial.quads[1]?.subjects).toEqual(real);
  });

  it("shapes a slot without content, position or well-formed facts", async () => {
    const { dial, facet, mint, odd } = rig();
    const c = await mint("c");
    const bare = await odd(c, "bare", () => []);
    const weird = await odd(c, "weird", (s) => [
      opAdd(s, TREE_POSITION, { toBlob: "5" }),
      opAdd(s, TREE_CONTENT, { toLiteral: "zzz" }),
      opAdd(s, TREE_REF, { toBlob: "9" }),
    ]);
    dial.reset();
    const out = await readContainers(facet, [c], { texts: true });
    const want = sorted([bare, weird]).map((slot) => ({
      slot,
      position: FALLBACK + slot,
      blobId: null,
      text: null,
      dangling: true,
    }));
    expect(out.containers[0]?.blocks).toStrictEqual(want);
    expect(dial.scalars[0]).toEqual([]);
    expect(out.containers[0]?.revision).toBe(
      sha([want.map((b) => `${b.slot}:`), null]),
    );
  });

  it("falls back to the slot token when positions cannot be resolved", async () => {
    const { dial, facet, mint } = rig();
    const c = await mint("c");
    await writeContainer(facet, c, [
      { op: "add", text: "p", position: "b" },
      { op: "add", text: "q", position: "a" },
    ]);
    dial.unresolvable = true;
    const out = await readContainers(facet, [c], { texts: true });
    const blocks = out.containers[0]?.blocks ?? [];
    const slots = blocks.map((b) => b.slot);
    expect(slots).toEqual(sorted(slots));
    expect(blocks.map((b) => b.position)).toEqual(
      slots.map((s) => FALLBACK + s),
    );
  });

  it("pins the revision to its digest and counts only what has content", async () => {
    const blobs = new Everywhere();
    const { facet, mint, odd } = rig(blobs);
    const c = await mint("c");
    await writeContainer(facet, c, [
      { op: "add", text: "real", position: "a" },
    ]);
    const bare = await odd(c, "bare", (s) => [
      opAdd(s, TREE_POSITION, { toLiteral: "b" }),
    ]);
    const real = (await readTree(facet.dial, c)).find((s) => s.slot !== bare);
    blobs.fetched = [];

    const withTexts = await readContainers(facet, [c], { texts: true });
    expect(blobs.fetched).toEqual([[real?.blobId]]);
    expect(withTexts.containers[0]?.revision).toBe(
      sha([[`${real?.slot ?? ""}:${real?.blobId ?? ""}`, `${bare}:`], null]),
    );
    // A slot without content is dangling and never given a text, even by a
    // store that would answer one.
    expect(
      withTexts.containers[0]?.blocks.map((b) => [b.text, b.dangling]),
    ).toEqual([
      ["x", false],
      [null, true],
    ]);

    blobs.fetched = [];
    const noTexts = await readContainers(facet, [c], { texts: false });
    expect(blobs.fetched).toEqual([]);
    expect(
      noTexts.containers[0]?.blocks.map((b) => [b.text, b.dangling]),
    ).toEqual([
      [null, false],
      [null, true],
    ]);
  });

  it("calls a block with a blob the store lacks dangling only when texts were asked", async () => {
    const { dial, facet, mint } = rig();
    const c = await mint("c");
    await dial.admit(
      [
        opCreate("Block", "g"),
        opAdd(c, TREE_MEMBER, { toNode: "g" }),
        opAdd("g", TREE_POSITION, { toLiteral: "a" }),
        opAdd("g", TREE_CONTENT, { toBlob: "999999" }),
      ],
      "notes",
    );
    const asked = await readContainers(facet, [c], { texts: true });
    expect(asked.containers[0]?.blocks[0]).toMatchObject({
      text: null,
      dangling: true,
    });
    const skipped = await readContainers(facet, [c], { texts: false });
    expect(skipped.containers[0]?.blocks[0]).toMatchObject({
      text: null,
      dangling: false,
    });
  });
});

describe("the history", () => {
  async function placedHistory() {
    const r = rig();
    const a = await r.mint("a");
    const origin =
      (
        await writeContainer(r.facet, a, [
          { op: "add", text: "v1", position: "a0" },
        ])
      ).minted[0] ?? "";
    const b = await r.mint("b");
    const p = await r.place(b, origin);
    const weird = await r.odd(b, "weird", (s) => [
      opAdd(s, TREE_REF, { toBlob: "9" }),
    ]);
    return { ...r, a, b, origin, p, weird };
  }

  it("asks nothing more of a container that holds nothing", async () => {
    const { dial, facet, mint } = rig();
    const c = await mint("c");
    dial.reset();
    await containerHistory(facet, c);
    expect(dial.quads).toHaveLength(1);
    expect(dial.histories).toHaveLength(1);
  });

  it("holds a blob-valued membership to be no member", async () => {
    const { dial, facet, mint } = rig();
    const c = await mint("c");
    await dial.admit([opAdd(c, TREE_MEMBER, { toBlob: "777" })], "notes");
    dial.reset();
    await containerHistory(facet, c);
    expect(dial.quads).toHaveLength(1);
  });

  it("stops after its own log when no member is a placement", async () => {
    const r = await placedHistory();
    r.dial.reset();
    await containerHistory(r.facet, r.a);
    expect(r.dial.histories).toHaveLength(1);
  });

  it("adds the origins' transactions, asking for exactly the well-formed origins", async () => {
    const r = await placedHistory();
    const slot = (await readTree(r.dial, r.a))[0];
    await writeContainer(r.facet, r.a, [
      {
        op: "update",
        slot: r.origin,
        oldBlobId: slot?.blobId ?? "",
        text: "v2",
      },
    ]);
    const editTx = r.lastTx();
    r.dial.reset();
    const hist = await containerHistory(r.facet, r.b);
    expect(hist.map((h) => h.tx)).toContain(editTx);
    const txs = hist.map((h) => h.tx);
    expect(txs).toEqual([...txs].sort((x, y) => x - y));
    expect(r.dial.histories).toEqual([
      { subjects: [r.b], follow: [TREE_MEMBER] },
      { subjects: [r.origin], follow: [] },
    ]);
    expect(r.dial.quads[1]).toMatchObject({
      preds: [TREE_REF],
      asOf: null,
    });
    expect(sorted(r.dial.quads[1]?.subjects ?? [])).toEqual(
      sorted([r.p, r.weird]),
    );
  });

  it("keeps its own entry for a transaction both logs share", async () => {
    const r = await placedHistory();
    const entry = (tx: number, author: string): HistoryEntry => ({
      tx,
      at: null,
      author,
      note: "",
    });
    r.dial.historyStub = (subjects) =>
      subjects[0] === r.b
        ? [entry(1, "own")]
        : [entry(1, "origin"), entry(2, "origin")];
    expect(await containerHistory(r.facet, r.b)).toEqual([
      entry(1, "own"),
      entry(2, "origin"),
    ]);
  });
});
