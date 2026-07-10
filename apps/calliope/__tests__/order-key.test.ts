import { describe, expect, it } from "vitest";
import { between, compareKeys, sequence } from "../src/order-key.js";

describe("order-key", () => {
  it("compareKeys is byte-wise (COLLATE C)", () => {
    expect(compareKeys("01", "02")).toBe(-1);
    expect(compareKeys("02", "01")).toBe(1);
    expect(compareKeys("05", "05")).toBe(0);
    // Byte order, not numeric: "10" < "9" as raw bytes.
    expect(compareKeys("10", "9")).toBe(-1);
  });

  it("sequence is ascending and byte-sortable, fixed width", () => {
    const keys = sequence(5);
    expect(keys).toHaveLength(5);
    const sorted = [...keys].sort(compareKeys);
    expect(sorted).toEqual(keys);
    // All same width => numeric and byte order agree.
    expect(new Set(keys.map((k) => k.length)).size).toBe(1);
  });

  it("sequence(0) is empty", () => {
    expect(sequence(0)).toEqual([]);
  });

  it("between yields a strictly-ordered key for bounded inputs", () => {
    const a = "02";
    const b = "04";
    const mid = between(a, b);
    expect(compareKeys(a, mid)).toBe(-1);
    expect(compareKeys(mid, b)).toBe(-1);
  });

  it("between handles adjacent keys by descending", () => {
    const a = "2";
    const b = "3";
    const mid = between(a, b);
    expect(compareKeys(a, mid)).toBe(-1);
    expect(compareKeys(mid, b)).toBe(-1);
  });

  it("between with null bounds is unbounded", () => {
    const first = between(null, "5");
    expect(compareKeys(first, "5")).toBe(-1);
    const last = between("5", null);
    expect(compareKeys("5", last)).toBe(-1);
    expect(between(null, null)).toBe("5");
  });

  it("between throws on misordered bounds", () => {
    expect(() => between("5", "3")).toThrow();
    expect(() => between("5", "5")).toThrow();
  });
});
