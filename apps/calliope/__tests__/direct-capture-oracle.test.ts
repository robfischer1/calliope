/**
 * Where calliope's direct capture follows themis (ops.ToWire / opsFromWire)
 * and admitcapture's reply contract and local-admit's `toCaptureOps` does not.
 * The golden file direct-capture.test.ts pins the shared cases.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ChaosClientError,
  LiveChaosDial,
  opAdd,
  opCreate,
  opRemove,
  type AdmitResult,
} from "../src/chaos-client.js";
import {
  classifyRefusal,
  mintedOf,
  toDirectCaptureOps,
} from "../src/direct-capture.js";
import { toCaptureOps } from "../src/local-admit.js";
import { throwIfMissingSubject } from "../src/mcp/migrate-tree.js";

const sha = (v: string, dtype = ""): string =>
  createHash("sha256").update(`${v}\x1f${dtype}\x1f`).digest("hex");
const NODE = "a".repeat(64);
const ISSUES = createHash("sha256").update("issues").digest("hex");

describe("toDirectCaptureOps vs the oracle", () => {
  it("honours the issues graph pin on addEdge; LocalChaosDial's port still ignores it", () => {
    const add = { ...opAdd(NODE, "p", { toNode: NODE }), graph: ISSUES };
    expect(toDirectCaptureOps([add], "moirae")[0]?.g).toBe(ISSUES);
    expect(toCaptureOps([add], "moirae")[0]?.g).toBe("moirae");
  });

  it("lower-cases an issues pin and ignores every other addEdge graph", () => {
    const up = {
      ...opAdd(NODE, "p", { toNode: NODE }),
      graph: ISSUES.toUpperCase(),
    };
    const other = {
      ...opAdd(NODE, "p", { toNode: NODE }),
      graph: "b".repeat(64),
    };
    expect(toDirectCaptureOps([up], "m")[0]?.g).toBe(ISSUES);
    expect(toDirectCaptureOps([other], "m")[0]?.g).toBe("m");
  });

  it("a removeEdge pin by NAME rides whole, as themis passes GraphHex", () => {
    const r = opRemove(NODE, "p", { toNode: NODE }, "issues");
    expect(toDirectCaptureOps([r], "m")[0]?.g).toBe("issues");
  });

  it("per-fact author rides the fact op only, never the intern", () => {
    const add = { ...opAdd(NODE, "p", { toLiteral: "x" }), author: "human" };
    expect(toDirectCaptureOps([add], "m")).toEqual([
      { op: "intern", value: "x" },
      {
        op: "addEdge",
        s: NODE,
        predicate: "p",
        o: sha("x"),
        g: "m",
        author: "human",
      },
    ]);
  });

  it("createNode takes node_type before kind", () => {
    expect(
      toDirectCaptureOps(
        [{ op: "createNode", node_type: "A", kind: "B", label: "" }],
        "m",
      ),
    ).toEqual([{ op: "createNode", label: "", kind: "A" }]);
  });

  it("naive: utc reads an offset-less instant as UTC; refuse (default) refuses it", () => {
    const micros = String(Date.UTC(2026, 0, 2, 3, 4, 5) * 1000);
    const utc = {
      ...opAdd(NODE, "w", {
        toLiteral: "2026-01-02T03:04:05",
        dtype: "instant",
      }),
      naive: "utc",
    };
    expect(toDirectCaptureOps([utc], "m")[0]).toEqual({
      op: "intern",
      value: micros,
      dtype: "instant",
    });
    const plain = opAdd(NODE, "w", {
      toLiteral: "2026-01-02T03:04:05",
      dtype: "instant",
    });
    expect(() => toDirectCaptureOps([plain], "m")).toThrow(
      /not a valid instant/,
    );
  });

  it.each([
    [
      { ...opAdd(NODE, "w", { toLiteral: "x" }), naive: "utc" },
      /naive is legal only with dtype instant/,
    ],
    [
      {
        ...opAdd(NODE, "w", {
          toLiteral: "2026-01-02T03:04:05",
          dtype: "instant",
        }),
        naive: "mars",
      },
      /not one of/,
    ],
    [
      {
        ...opAdd(NODE, "w", {
          toLiteral: "2026-01-02T03:04:05",
          dtype: "instant",
        }),
        naive: "eastern",
      },
      /eastern/,
    ],
    [
      { ...opAdd(NODE, "w", { toNode: NODE }), dtype: "instant" },
      /legal only beside a to_literal/,
    ],
    [{ op: "addEdge", from_id: NODE, predicate: "p" }, /exactly one/],
    [{ op: "close", id: NODE }, /unknown op close/],
    [opAdd(NODE, "p", { toLiteral: "a\u001fb" }), /unit-separator/],
  ])("refuses what themis refuses: %#", (op, msg) => {
    expect(() => toDirectCaptureOps([op], "m")).toThrow(msg);
    expect(() => toDirectCaptureOps([op], "m")).toThrow(ChaosClientError);
  });

  it("the create-label rules match toCaptureOps on the shared cases", () => {
    const batch = [opCreate("N", "a"), opAdd("a", "p", { toLiteral: "x" })];
    expect(toDirectCaptureOps(batch, "m")).toEqual(toCaptureOps(batch, "m"));
  });
});

describe("classifyRefusal (admitcapture reply.go)", () => {
  it.each([
    ["bad_args", "x", "bad_args"],
    ["unsigned_claim", "x", "unsigned_claim"],
    ["on_behalf_of_refused", "x", "on_behalf_of_refused"],
    ["policy_scope_refused", "x", "scope"],
    ["write_permission_refused", "x", "scope"],
  ])("%s is a definite refusal", (code, detail, check) => {
    expect(classifyRefusal(code, detail)).toEqual({ kind: "refused", check });
  });

  it.each([
    ["busy", "try later"],
    ["policy_unreadable", "x"],
    ["internal", "boom"],
    ["capture_refused", "gostore: commit: x"],
    ["capture_refused", "context deadline exceeded"],
    ["invalid_input", "a proxy said capture_refused earlier"],
  ])("%s %j is in doubt", (code, detail) => {
    expect(classifyRefusal(code, detail)).toEqual({ kind: "in_doubt" });
  });

  it("conflict is recognised by code and by text", () => {
    expect(classifyRefusal("conflict", "x")).toEqual({ kind: "conflict" });
    expect(classifyRefusal("x", "conflict: expect[0]")).toEqual({
      kind: "conflict",
    });
    expect(classifyRefusal("x", "capture_refused: conflict")).toEqual({
      kind: "conflict",
    });
  });
});

describe("mintedOf", () => {
  it("takes createNode ids in order, skips intern/edge echoes, lower-cases", () => {
    expect(
      mintedOf({
        results: [
          { op: "intern", id: "c".repeat(64) },
          { op: "createNode", id: "A".repeat(64) },
          { op: "addEdge", id: "d".repeat(64) },
          { op: "createNode", id: "" },
          { op: "createNode", id: "b".repeat(64) },
        ],
      }),
    ).toEqual(["a".repeat(64), "b".repeat(64)]);
  });
  it("falls back to an admit-shaped minted list", () => {
    expect(mintedOf({ minted: ["m", 3] })).toEqual(["m", "3"]);
  });
});

describe("migrate-tree carrier fallback under direct capture", () => {
  const violation = (detail: string): AdmitResult => ({
    admitted: false,
    minted: [],
    violations: [{ subject: "", check: "existence", detail, predicate: null }],
  });
  it("rethrows a missing-subject refusal as the error the fallback matches", () => {
    const res = violation(
      `capture_refused: subject guard: no nodes row for s=${NODE}`,
    );
    expect(() => {
      throwIfMissingSubject(res, NODE);
    }).toThrow(/no nodes row/);
    expect(() => {
      throwIfMissingSubject(res, NODE);
    }).toThrow(`s=${NODE}`);
  });
  it("leaves other refusals and admitted results alone", () => {
    expect(() => {
      throwIfMissingSubject(violation("cycle guard"), NODE);
    }).not.toThrow();
    expect(() => {
      throwIfMissingSubject(
        violation(`no nodes row for s=${"b".repeat(64)}`),
        NODE,
      );
    }).not.toThrow();
    expect(() => {
      throwIfMissingSubject(
        { admitted: true, minted: [], violations: [] },
        NODE,
      );
    }).not.toThrow();
  });
});

describe("flag on without chaos REST", () => {
  it("throws a clear config error instead of falling back to themis", async () => {
    const dial = new LiveChaosDial({
      themisUrl: "http://themis:8200",
      chaosUrl: "http://chaos:8209",
      directCapture: true,
    });
    await expect(dial.admit([opCreate("N", "n")], "m")).rejects.toThrow(
      /CALLIOPE_CHAOS_REST_URL/,
    );
  });
});
