/**
 * The one refusal form: {code, detail}, nothing else, extras folded into detail.
 */
import { describe, expect, it } from "vitest";
import { refuse, refusalBody, refusalResult } from "../src/refusal.js";

describe("refusalBody", () => {
  it("is exactly {code, detail} for a plain refusal", () => {
    expect(refusalBody({ code: "bad_args", detail: "x" })).toEqual({
      code: "bad_args",
      detail: "x",
    });
  });

  it("leaves empty extras out of the sentence", () => {
    expect(
      refusalBody({
        code: "admit_refused",
        detail: "d",
        violations: [],
        refused: [],
        notes: [],
      }),
    ).toEqual({ code: "admit_refused", detail: "d" });
  });

  it("folds the ids a batch refused, each with its own code", () => {
    expect(
      refusalBody({
        code: "batch_refused",
        detail: "2 of 3 id(s) refused",
        refused: [
          { code: "protected", detail: "a is archived" },
          { code: "not_a_note", detail: "b is no note" },
        ],
      }).detail,
    ).toBe(
      "2 of 3 id(s) refused (protected: a is archived; not_a_note: b is no note)",
    );
  });

  it("folds the notes that landed before the refusal", () => {
    expect(
      refusalBody({
        code: "admit_refused",
        detail: "d",
        notes: [{ node_id: "n1" }, { node_id: "n2" }],
      }).detail,
    ).toBe("d (landed first: n1, n2)");
  });

  it("folds the gate's violations as JSON", () => {
    expect(
      refusalBody({
        code: "admit_refused",
        detail: "d",
        violations: [{ rule: "r" }],
      }).detail,
    ).toBe('d (violations: [{"rule":"r"}])');
  });

  it("folds all three in a fixed order", () => {
    expect(
      refusalBody({
        code: "admit_refused",
        detail: "d",
        refused: [{ code: "c", detail: "e" }],
        notes: [{ node_id: "n" }],
        violations: [1],
      }).detail,
    ).toBe("d (c: e) (landed first: n) (violations: [1])");
  });
});

describe("refusalResult", () => {
  it("is an isError result whose text and structure agree", () => {
    const r = refusalResult({
      code: "admit_refused",
      detail: "d",
      violations: [1],
    });
    expect(r).toEqual({
      content: [{ type: "text", text: "admit_refused: d (violations: [1])" }],
      structuredContent: {
        code: "admit_refused",
        detail: "d (violations: [1])",
      },
      isError: true,
    });
  });

  it("refuse is the two-argument form", () => {
    expect(refuse("not_found", "gone")).toEqual({
      content: [{ type: "text", text: "not_found: gone" }],
      structuredContent: { code: "not_found", detail: "gone" },
      isError: true,
    });
  });
});
