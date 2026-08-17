/**
 * The local admit (spec 045 F13) — a PORT of go-court ops.go ToWire, held
 * to it by the SAME pinned constants its own tests use: cross-language
 * parity by constant, never by re-deriving with the code under test.
 */

import { describe, expect, it } from "vitest";
import { opAdd, opCreate, opRemove, scopeHash } from "../src/chaos-client.js";
import { contentHash, toCaptureOps } from "../src/local-admit.js";

// Pinned from themis go-court/internal/ops/ops_test.go (themselves pinned
// from the Python formulas): sha256("done\x1f\x1f") and sha256("moirae").
const DONE_CONTENT_HASH =
  "2411a110d4381fb605941b4185150c7e4e6fb0cb73bacc8b048f02e623f9884b";
const MOIRAE_GRAPH_HASH =
  "585e0303b9dced9b8aadfba60bdf4c6726c16c7dfc2aa58617d8b629163279f9";

describe("the local admit translation (045 F13)", () => {
  it("pins ContentHash and NameHash to the Go court's constants", () => {
    expect(contentHash("done")).toBe(DONE_CONTENT_HASH);
    expect(scopeHash("moirae")).toBe(MOIRAE_GRAPH_HASH);
  });

  it("refuses a scalar field carrying 0x1f — the collision guard", () => {
    expect(() => contentHash("ab")).toThrow(/0x1f/);
  });

  it("translates create + literal edge + node edge (the ToWire batch)", () => {
    const wire = toCaptureOps(
      [
        opCreate("Work", "the-card"),
        opAdd("the-card", "status", { toLiteral: "done" }),
        opAdd("the-card", "parent", { toNode: "aa11" }),
      ],
      "moirae",
    );
    expect(wire).toHaveLength(4); // create + intern + 2 edges
    expect(wire[0]).toEqual({
      op: "createNode",
      label: "the-card",
      kind: "Work",
    });
    expect(wire[1]).toEqual({ op: "intern", value: "done" });
    // g is sent bare (request side moved to names 2026-08-17): chaos's
    // capture door derives sha256(name) internally.
    expect(wire[2]).toEqual({
      op: "addEdge",
      s: { $mint: 0 },
      predicate: "status",
      o: DONE_CONTENT_HASH,
      g: "moirae",
    });
    expect(wire[3]).toEqual({
      op: "addEdge",
      s: { $mint: 0 },
      predicate: "parent",
      o: "aa11",
      g: "moirae",
    });
  });

  it("carries a blob target as the $blob object form", () => {
    const wire = toCaptureOps(
      [opAdd("aa".repeat(32), "tree_content", { toBlob: "17" })],
      "notes",
    );
    expect(wire).toHaveLength(1); // a blob edge interns nothing
    expect(wire[0]).toMatchObject({
      op: "addEdge",
      o: { $blob: "17" },
      g: "notes",
    });
  });

  it("refuses an unbound scope — the phantom-graph pin", () => {
    expect(() => toCaptureOps([opCreate("Note", "x")], "")).toThrow(/scope/);
  });

  it("refuses an ambiguous edge target", () => {
    expect(() =>
      toCaptureOps([opAdd("a", "p", { toLiteral: "x", toBlob: "1" })], "notes"),
    ).toThrow(/exactly one/);
  });

  it("first create wins a duplicate label — themis's exact rule", () => {
    const wire = toCaptureOps(
      [
        opCreate("Note", "twin"),
        opCreate("Note", "twin"),
        opAdd("twin", "parent", { toNode: "bb22" }),
      ],
      "notes",
    );
    expect(wire[2]).toMatchObject({ s: { $mint: 0 } });
  });

  it("pins a removeEdge to its recorded graph when given one", () => {
    const g = "cd".repeat(32);
    const wire = toCaptureOps(
      [{ ...opRemove("a", "p", { toLiteral: "v" }), graph: g }],
      "notes",
    );
    expect(wire[1]).toMatchObject({ op: "removeEdge", g });
  });
});
