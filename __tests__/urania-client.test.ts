import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HAS_PART,
  ORDER_KEY,
  SECTION_TYPE,
  TEXT,
  UraniaBodyClient,
} from "../src/urania-client.js";
import type {
  UraniaCapture,
  UraniaOp,
  UraniaTriple,
} from "../src/urania-client.js";

/**
 * An in-memory triple store standing in for urania-capture-via-Hades, so the
 * body-model mapping can be exercised without the live wire.
 */
class FakeCapture implements UraniaCapture {
  readonly triples: UraniaTriple[] = [];
  private minted = 0;

  resolve(subject: string): Promise<UraniaTriple[]> {
    return Promise.resolve(this.triples.filter((t) => t.from === subject));
  }

  capture(ops: UraniaOp[]): Promise<void> {
    for (const op of ops) {
      if (op.op === "createNode") {
        this.triples.push({
          from: op.id,
          predicate: "hasType",
          to: op.hasType,
        });
      } else if (op.op === "addEdge") {
        this.triples.push({
          from: op.from,
          predicate: op.predicate,
          to: op.to,
        });
      } else {
        const i = this.triples.findIndex(
          (t) =>
            t.from === op.from &&
            t.predicate === op.predicate &&
            t.to === op.to,
        );
        if (i >= 0) this.triples.splice(i, 1);
      }
    }
    return Promise.resolve();
  }

  mintSectionId(nodeId: string): string {
    return `${nodeId}#section/${String(this.minted++)}`;
  }
}

describe("UraniaBodyClient — unwired guard", () => {
  const prev = process.env.CALLIOPE_URANIA_WIRED;
  beforeEach(() => {
    delete process.env.CALLIOPE_URANIA_WIRED;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CALLIOPE_URANIA_WIRED;
    else process.env.CALLIOPE_URANIA_WIRED = prev;
  });

  it("throws 'not wired' on read with no transport / flag off", async () => {
    const client = new UraniaBodyClient();
    await expect(client.readBody("n1")).rejects.toThrow(/not.*wired|enabled/i);
  });

  it("throws even when a transport is injected but the flag is off", async () => {
    const client = new UraniaBodyClient(new FakeCapture());
    await expect(client.saveBody("n1", [{ text: "x" }])).rejects.toThrow(
      /not.*wired|enabled/i,
    );
  });
});

describe("UraniaBodyClient — body-model mapping (flag on)", () => {
  const prev = process.env.CALLIOPE_URANIA_WIRED;
  let fake: FakeCapture;
  let client: UraniaBodyClient;

  beforeEach(() => {
    process.env.CALLIOPE_URANIA_WIRED = "1";
    fake = new FakeCapture();
    client = new UraniaBodyClient(fake);
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CALLIOPE_URANIA_WIRED;
    else process.env.CALLIOPE_URANIA_WIRED = prev;
  });

  it("empty body reads as []", async () => {
    expect(await client.readBody("n1")).toEqual([]);
  });

  it("save writes hasPart / hasType section / text / order_key", async () => {
    await client.saveBody("note1", [{ text: "## H" }, { text: "para" }]);

    const hasPart = fake.triples.filter(
      (t) => t.from === "note1" && t.predicate === HAS_PART,
    );
    expect(hasPart).toHaveLength(2);

    for (const edge of hasPart) {
      const secTriples = fake.triples.filter((t) => t.from === edge.to);
      expect(
        secTriples.some(
          (t) => t.predicate === "hasType" && t.to === SECTION_TYPE,
        ),
      ).toBe(true);
      expect(secTriples.some((t) => t.predicate === TEXT)).toBe(true);
      expect(secTriples.some((t) => t.predicate === ORDER_KEY)).toBe(true);
    }
  });

  it("reads back sorted by order_key", async () => {
    await client.saveBody("note1", [
      { text: "first" },
      { text: "second" },
      { text: "third" },
    ]);
    const body = await client.readBody("note1");
    expect(body.map((s) => s.text)).toEqual(["first", "second", "third"]);
  });

  it("copy-on-write: changed prose mints a NEW section node, old stays", async () => {
    await client.saveBody("note1", [{ text: "original" }]);
    const before = await client.readBody("note1");
    const oldId = before[0]?.id ?? "";
    expect(oldId).not.toBe("");

    await client.saveBody("note1", [{ text: "edited" }]);
    const after = await client.readBody("note1");

    // hasPart now points at a new node...
    expect(after[0]?.text).toBe("edited");
    expect(after[0]?.id).not.toBe(oldId);
    // ...the old hasPart edge was removed (note no longer references it)...
    const stillLinked = fake.triples.some(
      (t) => t.from === "note1" && t.predicate === HAS_PART && t.to === oldId,
    );
    expect(stillLinked).toBe(false);
    // ...but the old section node (its text literal) is left in place.
    const oldTextSurvives = fake.triples.some(
      (t) => t.from === oldId && t.predicate === TEXT && t.to === "original",
    );
    expect(oldTextSurvives).toBe(true);
  });

  it("unchanged prose reuses the node; only order_key moves on reorder", async () => {
    await client.saveBody("note1", [{ text: "a" }, { text: "b" }]);
    const before = await client.readBody("note1");
    const idA = before.find((s) => s.text === "a")?.id ?? "";
    expect(idA).not.toBe("");

    // Reorder: b then a. "a" is byte-identical => same node, new order_key.
    await client.saveBody("note1", [{ text: "b" }, { text: "a" }]);
    const after = await client.readBody("note1");

    expect(after.map((s) => s.text)).toEqual(["b", "a"]);
    expect(after.find((s) => s.text === "a")?.id).toBe(idA);
  });

  it("dropping a section unwires its hasPart but keeps the node", async () => {
    await client.saveBody("note1", [{ text: "keep" }, { text: "drop" }]);
    const before = await client.readBody("note1");
    const dropId = before.find((s) => s.text === "drop")?.id ?? "";
    expect(dropId).not.toBe("");

    await client.saveBody("note1", [{ text: "keep" }]);
    const after = await client.readBody("note1");

    expect(after.map((s) => s.text)).toEqual(["keep"]);
    const stillLinked = fake.triples.some(
      (t) => t.from === "note1" && t.predicate === HAS_PART && t.to === dropId,
    );
    expect(stillLinked).toBe(false);
    const nodeSurvives = fake.triples.some((t) => t.from === dropId);
    expect(nodeSurvives).toBe(true);
  });
});
