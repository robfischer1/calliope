/**
 * The date-time grammar pinned at its edges: every shape the two text
 * patterns must refuse or read one particular way, the calendar and offset
 * bounds, and the leap-day rule. Synthetic values only.
 */

import { describe, expect, it } from "vitest";
import {
  asDateTime,
  canonicalInstant,
  canonicalWallclock,
  isDateTime,
  literalTarget,
  parseInstantMicros,
  retractTargets,
  timeDtype,
} from "../src/instant.js";

describe("the text patterns, shape by shape", () => {
  // [text, parseInstantMicros, canonicalWallclock, canonicalInstant, timeDtype]
  const shapes: [
    string,
    string | null,
    string | null,
    string | null,
    string | null,
  ][] = [
    [
      "0001-12-31T23:59:59.9999999+0059",
      "-62104064340000001",
      null,
      "-62104064340000001",
      "instant",
    ],
    ["1234567890123456", null, null, "1234567890123456", null],
    ["2026-10-17t18:11:45", null, "2026-10-17T18:11:45", null, "wallclock"],
    ["2026-10-17T18:11:45+", null, null, null, null],
    [
      "2026-10-17 18:11:45.5-04:00",
      "1792275105500000",
      null,
      "1792275105500000",
      "instant",
    ],
    ["-9", null, null, "-9", null],
    [
      "2026-10-17T18:11:45+04",
      "1792246305000000",
      null,
      "1792246305000000",
      "instant",
    ],
    ["20266-10-17T18:11:45", null, null, null, null],
    ["-0", null, null, null, null],
    [
      "2026-10-17T18:11:45Z",
      "1792260705000000",
      null,
      "1792260705000000",
      "instant",
    ],
    [
      "2026-10-17T18:11:45z",
      "1792260705000000",
      null,
      "1792260705000000",
      "instant",
    ],
    ["2026-10-17T18:11:45+04:", null, null, null, null],
    ["2026-10-17T18:11:45+04:00:00", null, null, null, null],
    ["2026-10-17T18:11:45Zz", null, null, null, null],
    ["2026-10-17T18:11:45+04000", null, null, null, null],
    ["2026-10-17T18:11:45.", null, null, null, null],
    ["2026-10-17T1:11:45", null, null, null, null],
    ["2026-10-17T18:1:45", null, null, null, null],
    ["2026-10-17T18:11:4", null, null, null, null],
    ["2026-10-17x18:11:45", null, null, null, null],
    ["2026-1-17T18:11:45", null, null, null, null],
    ["2026-10-7T18:11:45", null, null, null, null],
    ["26-10-17T18:11:45", null, null, null, null],
    ["--1", null, null, null, null],
    ["2026-010-17T18:11:45Z", null, null, null, null],
    ["2026-10-017T18:11:45Z", null, null, null, null],
    ["2026-10-17T018:11:45Z", null, null, null, null],
    ["2026-10-17T18:011:45Z", null, null, null, null],
    ["2026-10-17T18:11:045Z", null, null, null, null],
    ["2026-10-17T18:11:45.5.6Z", null, null, null, null],
    ["2026-10-17T18:11:45+04::00", null, null, null, null],
    ["2026-10-17T18:11:45x04:00", null, null, null, null],
    ["x026-10-17T18:11:45Z", null, null, null, null],
    ["2026-x1-17T18:11:45Z", null, null, null, null],
    ["2026-10-x7T18:11:45Z", null, null, null, null],
    ["2026-10-17Tx8:11:45Z", null, null, null, null],
    ["2026-10-17T18:x1:45Z", null, null, null, null],
    ["2026-10-17T18:11:x5Z", null, null, null, null],
    ["2026-10-17T18:11:45.xZ", null, null, null, null],
    ["2026-10-17T18:11:45+x4:00", null, null, null, null],
    ["2026-10-17T18:11:45+04:x0", null, null, null, null],
  ];

  it.each(shapes)("%j", (text, micros, wallclock, instant, dtype) => {
    expect(parseInstantMicros(text)?.toString() ?? null).toBe(micros);
    expect(canonicalWallclock(text)).toBe(wallclock);
    expect(canonicalInstant(text)).toBe(instant);
    expect(timeDtype("mtime", text) ?? null).toBe(dtype);
  });

  it("a three-digit field with a leading zero is not a two-digit field", () => {
    for (const text of [
      "2026-010-17T18:11:45Z",
      "2026-10-017T18:11:45Z",
      "2026-10-17T018:11:45Z",
      "2026-10-17T18:011:45Z",
      "2026-10-17T18:11:045Z",
    ]) {
      expect(parseInstantMicros(text), text).toBeNull();
      expect(canonicalWallclock(text.replace("Z", "")), text).toBeNull();
    }
  });
});

describe("the calendar", () => {
  it.each(["2000-02-29", "2024-02-29", "2400-02-29"])("%s is a day", (d) => {
    expect(canonicalWallclock(`${d}T00:00:00`)).toBe(`${d}T00:00:00`);
  });

  it.each(["1900-02-29", "2100-02-29", "2023-02-29", "2026-02-30"])(
    "%s is not a day",
    (d) => {
      expect(canonicalWallclock(`${d}T00:00:00`)).toBeNull();
      expect(parseInstantMicros(`${d}T00:00:00Z`)).toBeNull();
    },
  );

  it.each([
    ["2026-01-31", true],
    ["2026-03-31", true],
    ["2026-04-30", true],
    ["2026-04-31", false],
    ["2026-05-31", true],
    ["2026-06-30", true],
    ["2026-06-31", false],
    ["2026-07-31", true],
    ["2026-08-31", true],
    ["2026-09-30", true],
    ["2026-09-31", false],
    ["2026-10-31", true],
    ["2026-11-30", true],
    ["2026-11-31", false],
    ["2026-12-31", true],
    ["2026-02-28", true],
    ["2026-12-32", false],
  ])("%s holds: %s", (d, holds) => {
    expect(canonicalWallclock(`${d}T00:00:00`) !== null).toBe(holds);
  });

  it("month zero, day zero and year zero name nothing", () => {
    for (const text of [
      "2026-00-10T00:00:00",
      "2026-10-00T00:00:00",
      "0000-01-01T00:00:00",
      "2026-13-10T00:00:00",
    ]) {
      expect(canonicalWallclock(text), text).toBeNull();
      expect(parseInstantMicros(`${text}Z`), text).toBeNull();
    }
    expect(canonicalWallclock("0001-01-01T00:00:00")).toBe(
      "0001-01-01T00:00:00",
    );
  });

  it("the time of day stops at 23:59:59", () => {
    expect(canonicalWallclock("2026-10-17T23:59:59")).not.toBeNull();
    expect(canonicalWallclock("2026-10-17T24:00:00")).toBeNull();
    expect(canonicalWallclock("2026-10-17T23:60:00")).toBeNull();
    expect(canonicalWallclock("2026-10-17T23:59:60")).toBeNull();
  });
});

describe("offsets", () => {
  it("an offset is valid up to +23:59 and refused past it", () => {
    expect(parseInstantMicros("2026-10-17T18:11:45+23:00")).not.toBeNull();
    expect(parseInstantMicros("2026-10-17T18:11:45+04:59")).not.toBeNull();
    expect(parseInstantMicros("2026-10-17T18:11:45+23:59")).not.toBeNull();
    expect(parseInstantMicros("2026-10-17T18:11:45+24:00")).toBeNull();
    expect(parseInstantMicros("2026-10-17T18:11:45-04:60")).toBeNull();
  });

  it("Z reads as a zero offset whatever follows the sign slots", () => {
    expect(parseInstantMicros("2026-10-17T18:11:45Z")).toBe(
      parseInstantMicros("2026-10-17T18:11:45+00:00"),
    );
    expect(parseInstantMicros("2026-10-17T18:11:45-00:30")).toBe(
      (parseInstantMicros("2026-10-17T18:11:45Z") ?? 0n) + 1_800_000_000n,
    );
  });

  it("the instant domain is 0001-01-01Z .. 9999-12-31T23:59:59.999999Z, both ends", () => {
    expect(parseInstantMicros("0001-01-01T00:00:00Z")).not.toBeNull();
    expect(parseInstantMicros("0001-01-01T00:00:00+00:01")).toBeNull();
    expect(parseInstantMicros("9999-12-31T23:59:59.999999Z")).not.toBeNull();
    expect(parseInstantMicros("9999-12-31T23:59:59.999999-00:01")).toBeNull();
    expect(parseInstantMicros("9999-12-31T23:59:59-00:01")).toBeNull();
  });
});

describe("asDateTime and isDateTime", () => {
  it("a leap second is a time, :61 is not", () => {
    expect(asDateTime("2016-12-31T23:59:60Z")).toBe("2016-12-31T23:59:60Z");
    expect(asDateTime("2016-12-31T23:59:61Z")).toBeNull();
  });

  it("only text that is already a date-time is one", () => {
    expect(isDateTime(null)).toBe(false);
    expect(isDateTime(undefined)).toBe(false);
    expect(isDateTime(1)).toBe(false);
    expect(isDateTime("2026-10-17T18:11:45Z")).toBe(true);
  });
});

describe("literalTarget carries a dtype only for a time fact", () => {
  it("an untyped target has no dtype key at all", () => {
    expect(Object.keys(literalTarget("status", "x"))).toEqual(["toLiteral"]);
    expect(Object.keys(literalTarget("created", "2026-10-17"))).toEqual([
      "toLiteral",
    ]);
    expect(retractTargets("status", "x").map((t) => Object.keys(t))).toEqual([
      ["toLiteral"],
    ]);
  });
});
