import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { HAS_PART, TEXT, UraniaBodyClient } from "../src/urania-client.js";
import type {
  UraniaCapture,
  UraniaOp,
  UraniaTriple,
} from "../src/urania-client.js";

/** Same in-memory triple store the urania-client test uses. */
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

describe("FixtureBodyClient.editSection", () => {
  it("edits one section in place, keeping order key + others", async () => {
    const client = new FixtureBodyClient();
    await client.saveBody("n1", [{ text: "a" }, { text: "b" }, { text: "c" }]);
    const before = await client.readBody("n1");
    const bId = before[1]?.id ?? "";
    const bKey = before[1]?.orderKey ?? "";

    const edited = await client.editSection("n1", bId, "B!");
    expect(edited.text).toBe("B!");
    expect(edited.orderKey).toBe(bKey);
    expect(edited.id).not.toBe(bId); // copy-on-write identity change

    const after = await client.readBody("n1");
    expect(after.map((s) => s.text)).toEqual(["a", "B!", "c"]);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[2]?.id).toBe(before[2]?.id);
  });

  it("rejects an unknown section id", async () => {
    const client = new FixtureBodyClient();
    await client.saveBody("n1", [{ text: "a" }]);
    await expect(client.editSection("n1", "missing", "x")).rejects.toThrow(
      /not part of/i,
    );
  });
});

describe("UraniaBodyClient.editSection (flag on)", () => {
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

  it("copy-on-write: mints a new node at the same order_key, rewires hasPart", async () => {
    await client.saveBody("note1", [{ text: "x" }, { text: "y" }]);
    const before = await client.readBody("note1");
    const yId = before.find((s) => s.text === "y")?.id ?? "";
    const yKey = before.find((s) => s.text === "y")?.orderKey ?? "";
    expect(yId).not.toBe("");

    const edited = await client.editSection("note1", yId, "Y2");
    expect(edited.text).toBe("Y2");
    expect(edited.orderKey).toBe(yKey); // position preserved
    expect(edited.id).not.toBe(yId);

    const after = await client.readBody("note1");
    expect(after.map((s) => s.text)).toEqual(["x", "Y2"]);

    // old hasPart edge gone, old text node survives
    const oldLinked = fake.triples.some(
      (t) => t.from === "note1" && t.predicate === HAS_PART && t.to === yId,
    );
    expect(oldLinked).toBe(false);
    const oldTextSurvives = fake.triples.some(
      (t) => t.from === yId && t.predicate === TEXT && t.to === "y",
    );
    expect(oldTextSurvives).toBe(true);
  });

  it("rejects an unknown section id", async () => {
    await client.saveBody("note1", [{ text: "x" }]);
    await expect(client.editSection("note1", "nope", "z")).rejects.toThrow(
      /not part of/i,
    );
  });
});
