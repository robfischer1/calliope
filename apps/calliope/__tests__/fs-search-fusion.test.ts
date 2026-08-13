import { describe, expect, it } from "vitest";
import { rrfFuse, RRF_K } from "../src/fs-search/fusion.js";

describe("rrfFuse", () => {
  it("N=1: fusing one list preserves its exact order (degradation honesty)", () => {
    const fused = rrfFuse(
      [
        {
          arm: "fts",
          entries: [{ id: "a.md" }, { id: "b.md" }, { id: "c.md" }],
        },
      ],
      10,
    );
    expect(fused.map((h) => h.id)).toEqual(["a.md", "b.md", "c.md"]);
    expect(fused.every((h) => h.arms.length === 1 && h.arms[0] === "fts")).toBe(
      true,
    );
  });

  it("a hit ranked by both arms appears once, carries both, outranks singles", () => {
    const fused = rrfFuse(
      [
        { arm: "fts", entries: [{ id: "only-fts.md" }, { id: "both.md" }] },
        {
          arm: "semantic",
          entries: [{ id: "both.md" }, { id: "only-sem.md" }],
        },
      ],
      10,
    );
    expect(fused[0]?.id).toBe("both.md");
    expect(fused[0]?.arms.sort()).toEqual(["fts", "semantic"]);
    expect(fused).toHaveLength(3);
    const both = fused[0]?.score ?? 0;
    expect(both).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 10);
  });

  it("snippet preference: the first list offering one wins", () => {
    const fused = rrfFuse(
      [
        { arm: "fts", entries: [{ id: "x.md", snippet: "marked snippet" }] },
        { arm: "semantic", entries: [{ id: "x.md", snippet: "block head" }] },
      ],
      10,
    );
    expect(fused[0]?.snippet).toBe("marked snippet");
  });

  it("empty input fuses to empty output", () => {
    expect(rrfFuse([], 10)).toEqual([]);
  });

  it("respects the limit", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      id: `${String(i)}.md`,
    }));
    expect(rrfFuse([{ arm: "fts", entries }], 20)).toHaveLength(20);
  });
});
