import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HAS_PART,
  ORDER_KEY,
  SECTION_TYPE,
  TEXT,
  UraniaBodyClient,
} from "../src/urania-client.js";
import type {
  AuthoredBy,
  UraniaCapture,
  UraniaOp,
  UraniaTriple,
} from "../src/urania-client.js";
import type { BlockOp, BlockOpEmitter } from "../src/types.js";

/** Collects emitted block-ops for test assertions. */
class FakeBlockOpEmitter implements BlockOpEmitter {
  readonly ops: BlockOp[] = [];
  emit(op: BlockOp): void {
    this.ops.push(op);
  }
}

/**
 * An in-memory triple store standing in for urania-capture-via-Hades, so the
 * body-model mapping can be exercised without the live wire.
 */
class FakeCapture implements UraniaCapture {
  readonly triples: UraniaTriple[] = [];
  /** Records the `authoredBy` value passed on each `capture()` call. */
  readonly capturedProvenance: AuthoredBy[] = [];
  private minted = 0;

  resolve(subject: string): Promise<UraniaTriple[]> {
    return Promise.resolve(this.triples.filter((t) => t.from === subject));
  }

  capture(ops: UraniaOp[], authoredBy: AuthoredBy = "human"): Promise<void> {
    this.capturedProvenance.push(authoredBy);
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

  mintSectionId(nodeId?: string): string {
    return `${nodeId ?? ""}#section/${String(this.minted++)}`;
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

describe("UraniaBodyClient — provenance / authoredBy threading", () => {
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

  it("saveBody defaults to authoredBy='human'", async () => {
    await client.saveBody("note1", [{ text: "hello" }]);
    expect(fake.capturedProvenance).toEqual(["human"]);
  });

  it("saveBody passes through authoredBy='calliope' when specified", async () => {
    await client.saveBody("note1", [{ text: "hello" }], "calliope");
    expect(fake.capturedProvenance).toEqual(["calliope"]);
  });

  it("editSection defaults to authoredBy='human'", async () => {
    // Seed a section first so editSection has something to find.
    await client.saveBody("note2", [{ text: "original" }]);
    fake.capturedProvenance.length = 0; // reset after seed
    const body = await client.readBody("note2");
    const sectionId = body[0]?.id ?? "";
    await client.editSection("note2", sectionId, "updated");
    expect(fake.capturedProvenance).toEqual(["human"]);
  });

  it("editSection passes through authoredBy='calliope' when specified", async () => {
    await client.saveBody("note3", [{ text: "original" }]);
    fake.capturedProvenance.length = 0;
    const body = await client.readBody("note3");
    const sectionId = body[0]?.id ?? "";
    await client.editSection("note3", sectionId, "updated", "calliope");
    expect(fake.capturedProvenance).toEqual(["calliope"]);
  });
});

// ---------------------------------------------------------------------------
// F3 — Block-op transaction log
// ---------------------------------------------------------------------------

/** All 7 required BlockOp fields. */
const BLOCK_OP_FIELDS = [
  "block_id",
  "op_type",
  "content_delta",
  "order_key",
  "timestamp",
  "authored_by",
  "node_id",
] as const;

/** Assert every required field is present and non-empty-string where required. */
function assertAllFields(op: BlockOp, nodeId: string): void {
  for (const field of BLOCK_OP_FIELDS) {
    expect(op).toHaveProperty(field);
  }
  expect(op.node_id).toBe(nodeId);
  expect(op.block_id).toBeTruthy();
  expect(op.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
}

describe("UraniaBodyClient — block-op transaction log (F3)", () => {
  const prev = process.env.CALLIOPE_URANIA_WIRED;
  let fake: FakeCapture;
  let emitter: FakeBlockOpEmitter;
  let client: UraniaBodyClient;

  beforeEach(() => {
    process.env.CALLIOPE_URANIA_WIRED = "1";
    fake = new FakeCapture();
    emitter = new FakeBlockOpEmitter();
    client = new UraniaBodyClient(fake, emitter);
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CALLIOPE_URANIA_WIRED;
    else process.env.CALLIOPE_URANIA_WIRED = prev;
  });

  it("saveBody of a new section emits an 'add' op with all 7 fields", async () => {
    await client.saveBody("n1", [{ text: "hello" }]);
    expect(emitter.ops).toHaveLength(1);
    const op = emitter.ops[0] ?? ({ op_type: undefined } as unknown as BlockOp);
    assertAllFields(op, "n1");
    expect(op.op_type).toBe("add");
    expect(op.content_delta).toBe("hello");
    expect(op.authored_by).toBe("human");
  });

  it("saveBody with changed prose emits an 'update' op carrying the new text", async () => {
    await client.saveBody("n2", [{ text: "original" }]);
    emitter.ops.length = 0; // reset after seed

    await client.saveBody("n2", [{ text: "edited" }]);
    const updateOp = emitter.ops.find((o) => o.op_type === "update");
    expect(updateOp).toBeDefined();
    if (updateOp === undefined) return;
    expect(updateOp.content_delta).toBe("edited");
    assertAllFields(updateOp, "n2");
    expect(updateOp.authored_by).toBe("human");
  });

  it("dropping a section emits a 'delete' op with the section's last order_key", async () => {
    await client.saveBody("n3", [{ text: "keep" }, { text: "drop" }]);
    const body = await client.readBody("n3");
    const dropSec = body.find((s) => s.text === "drop");
    expect(dropSec).toBeDefined();
    if (dropSec === undefined) return;
    emitter.ops.length = 0;

    await client.saveBody("n3", [{ text: "keep" }]);
    const delOp = emitter.ops.find((o) => o.op_type === "delete");
    expect(delOp).toBeDefined();
    if (delOp === undefined) return;
    assertAllFields(delOp, "n3");
    expect(delOp.block_id).toBe(dropSec.id);
    expect(delOp.content_delta).toBe("");
    expect(delOp.order_key).toBe(dropSec.orderKey);
  });

  it("reordering sections emits a 'reorder' op with the new order_key", async () => {
    await client.saveBody("n4", [{ text: "a" }, { text: "b" }]);
    const bodyBefore = await client.readBody("n4");
    const secA = bodyBefore.find((s) => s.text === "a");
    expect(secA).toBeDefined();
    if (secA === undefined) return;
    emitter.ops.length = 0;

    // Swap order: b then a — both sections move, so two reorder ops are emitted.
    await client.saveBody("n4", [{ text: "b" }, { text: "a" }]);

    // At least one reorder op must be emitted.
    const reorderOps = emitter.ops.filter((o) => o.op_type === "reorder");
    expect(reorderOps.length).toBeGreaterThanOrEqual(1);

    // Specifically, a reorder op must exist for secA (text "a").
    const reorderA = reorderOps.find((o) => o.block_id === secA.id);
    expect(reorderA).toBeDefined();
    if (reorderA === undefined) return;
    assertAllFields(reorderA, "n4");
    expect(reorderA.content_delta).toBe(""); // prose unchanged
    // The new order_key is different from secA's original order_key.
    expect(reorderA.order_key).not.toBe(secA.orderKey);
  });

  it("editSection emits an 'update' op carrying human provenance from F2", async () => {
    await client.saveBody("n5", [{ text: "original" }]);
    const body = await client.readBody("n5");
    const sectionId = body[0]?.id ?? "";
    expect(sectionId).not.toBe("");
    emitter.ops.length = 0;

    await client.editSection("n5", sectionId, "updated prose");
    expect(emitter.ops).toHaveLength(1);
    const op = emitter.ops[0];
    expect(op).toBeDefined();
    if (op === undefined) return;
    assertAllFields(op, "n5");
    expect(op.op_type).toBe("update");
    expect(op.content_delta).toBe("updated prose");
    expect(op.authored_by).toBe("human"); // F2 provenance
  });

  it("editSection with explicit calliope provenance carries calliope in authored_by", async () => {
    await client.saveBody("n6", [{ text: "original" }]);
    const body = await client.readBody("n6");
    const sectionId = body[0]?.id ?? "";
    expect(sectionId).not.toBe("");
    emitter.ops.length = 0;

    await client.editSection("n6", sectionId, "machine edit", "calliope");
    const op = emitter.ops[0];
    expect(op).toBeDefined();
    if (op === undefined) return;
    expect(op.authored_by).toBe("calliope");
  });

  it("block-op log is append-only: emitter.emit is never called with a mutation of prior ops", async () => {
    // Emit 3 saves; verify all ops accumulate, none are removed or replaced.
    await client.saveBody("n7", [{ text: "alpha" }]);
    await client.saveBody("n7", [{ text: "alpha" }, { text: "beta" }]);
    await client.saveBody("n7", [{ text: "beta" }]);

    // Every emitted op should still be in the array — no splices, no rewrites.
    // The emitter array itself IS the append-only log: its length only grows.
    expect(emitter.ops.length).toBeGreaterThanOrEqual(3);
    for (const op of emitter.ops) {
      // Each op has a valid op_type — no undefined/null entries (corruption check)
      expect(["add", "update", "delete", "reorder"]).toContain(op.op_type);
    }
  });

  it("no block-op emitter: saveBody still works without errors", async () => {
    // Client without emitter — no second constructor arg
    const plainClient = new UraniaBodyClient(fake);
    await expect(
      plainClient.saveBody("n8", [{ text: "x" }]),
    ).resolves.toBeUndefined();
  });
});

describe("UraniaBodyClient — applySectionOps (A11)", () => {
  const prev = process.env.CALLIOPE_URANIA_WIRED;
  let fake: FakeCapture;
  let emitter: FakeBlockOpEmitter;
  let client: UraniaBodyClient;

  beforeEach(async () => {
    process.env.CALLIOPE_URANIA_WIRED = "1";
    fake = new FakeCapture();
    emitter = new FakeBlockOpEmitter();
    client = new UraniaBodyClient(fake, emitter);
    await client.saveBody("na", [
      { text: "alpha" },
      { text: "beta" },
      { text: "gamma" },
    ]);
    emitter.ops.length = 0; // only observe the apply's emissions
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CALLIOPE_URANIA_WIRED;
    else process.env.CALLIOPE_URANIA_WIRED = prev;
  });

  it("applies a mixed batch in ONE capture; block-ops emit 1:1", async () => {
    const before = await client.readBody("na");
    const [alpha, beta, gamma] = before;
    if (!alpha || !beta || !gamma) throw new Error("fixture body missing");
    const captureCalls = fake.capturedProvenance.length;

    const { sections, applied } = await client.applySectionOps("na", [
      { op: "update", sectionId: beta.id, text: "beta edited" },
      { op: "add", text: "wedged", orderKey: "015" },
      { op: "reorder", sectionId: gamma.id, orderKey: "005" },
      { op: "delete", sectionId: alpha.id },
    ]);

    // ONE capture batch (atomic at the substrate).
    expect(fake.capturedProvenance.length).toBe(captureCalls + 1);
    expect(sections.map((s) => s.text)).toEqual([
      "gamma",
      "wedged",
      "beta edited",
    ]);
    // Reorder keeps the node id (the edge moves, not the node).
    expect(applied.at(2)?.id).toBe(gamma.id);
    // Update mints a fresh version node; delete reports the removed id.
    expect(applied.at(0)?.id).not.toBe(beta.id);
    expect(applied.at(3)?.id).toBe(alpha.id);
    // Block-ops 1:1 with the submitted ops, in order.
    expect(emitter.ops.map((o) => o.op_type)).toEqual([
      "update",
      "add",
      "reorder",
      "delete",
    ]);
    expect(emitter.ops.at(1)?.content_delta).toBe("wedged");
    expect(emitter.ops.at(2)?.order_key).toBe("005");
  });

  it("a stale id rejects the whole batch — nothing captured, nothing emitted", async () => {
    const before = await client.readBody("na");
    const alpha = before.at(0);
    if (alpha === undefined) throw new Error("fixture body missing");
    const captureCalls = fake.capturedProvenance.length;
    await expect(
      client.applySectionOps("na", [
        { op: "update", sectionId: alpha.id, text: "x" },
        { op: "reorder", sectionId: "nope", orderKey: "9" },
      ]),
    ).rejects.toThrow(/stale_section/);
    expect(fake.capturedProvenance.length).toBe(captureCalls);
    expect(emitter.ops).toHaveLength(0);
    expect((await client.readBody("na")).map((s) => s.text)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("a duplicate section id in one batch is rejected as malformed", async () => {
    const before = await client.readBody("na");
    const alpha = before.at(0);
    if (alpha === undefined) throw new Error("fixture body missing");
    await expect(
      client.applySectionOps("na", [
        { op: "update", sectionId: alpha.id, text: "x" },
        { op: "delete", sectionId: alpha.id },
      ]),
    ).rejects.toThrow(/duplicate/);
  });
});
