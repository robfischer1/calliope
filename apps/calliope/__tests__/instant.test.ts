import { describe, expect, it } from "vitest";
import {
  asDateTime,
  isDateTime,
  TIME_PREDICATES,
  canonicalInstant,
  canonicalWallclock,
  compareTimes,
  literalTarget,
  parseInstantMicros,
  renderEastern,
  retractTargets,
  sameTime,
  sameValue,
  timeDtype,
} from "../src/instant.js";

describe("asDateTime — what the client's date-time format accepts", () => {
  it("keeps an instant that already carries Z or a full offset", () => {
    for (const ok of [
      "2026-10-17T12:00:00Z",
      "2026-05-27T10:39:48.080Z",
      "2026-10-17T08:00:00.250000-04:00",
    ]) {
      expect(asDateTime(ok)).toBe(ok);
      expect(isDateTime(ok)).toBe(true);
    }
  });

  it("normalises Postgres's text cast of a timestamptz, keeping instant and offset", () => {
    expect(asDateTime("2026-08-01 09:15:00.5-04")).toBe(
      "2026-08-01T09:15:00.5-04:00",
    );
    expect(asDateTime("2026-08-01 09:15:00+00")).toBe(
      "2026-08-01T09:15:00+00:00",
    );
    expect(isDateTime("2026-08-01 09:15:00+00")).toBe(false);
  });

  it("refuses what is not an instant: naive, date-only, epoch, prose, impossible dates", () => {
    for (const bad of [
      "",
      "never",
      "-",
      "1760000000",
      "2026-10-17",
      "2026-10-17T12:00:00",
      "2026-02-30T12:00:00Z",
      "2026-13-01T12:00:00Z",
      "2026-10-17T24:00:00Z",
      "2026-10-17T12:00:00+25:00",
    ]) {
      expect(asDateTime(bad), bad).toBeNull();
    }
    expect(asDateTime(null)).toBeNull();
    expect(asDateTime(undefined)).toBeNull();
  });
});

describe("parseInstantMicros", () => {
  it.each([
    ["1970-01-01T00:00:00Z", 0n],
    ["1970-01-01T00:00:00+00:00", 0n],
    ["1970-01-01T00:00:00z", 0n],
    ["1970-01-01 00:00:00Z", 0n],
    ["1970-01-01T00:00:01Z", 1000000n],
    ["1969-12-31T23:59:59Z", -1000000n],
    ["1969-12-31T23:59:59.5Z", -500000n],
    ["2026-10-17T18:11:45.188000-04:00", 1792275105188000n],
    ["2026-10-17T22:11:45.188Z", 1792275105188000n],
    ["2026-10-17T18:11:45.188-0400", 1792275105188000n],
    ["2026-10-17T18:11:45.188-04", 1792275105188000n],
    ["2026-01-05T09:00:00-05:00", 1767621600000000n],
    ["2026-01-05T14:00:00Z", 1767621600000000n],
    // floored to the microsecond, never rounded
    ["1970-01-01T00:00:00.1234569Z", 123456n],
    ["1970-01-01T00:00:00.9999999Z", 999999n],
    ["2000-02-29T00:00:00Z", 951782400000000n],
    ["0001-01-01T00:00:00Z", -62135596800000000n],
    ["9999-12-31T23:59:59.999999Z", 253402300799999999n],
  ])("%s -> %s", (text, micros) => {
    expect(parseInstantMicros(text)).toBe(micros);
  });

  it.each([
    "2026-10-17",
    "2026-10-17T18:11:45",
    "2026-10-17T18:11:45.5",
    "not a time",
    "",
    "1792260705",
    "2026-13-01T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-10-17T24:00:00Z",
    "2026-10-17T18:60:00Z",
    "2026-10-17T18:11:60Z",
    "2026-10-17T18:11:45+24:00",
    "2026-10-17T18:11:45+04:60",
    "0000-01-01T00:00:00Z",
    "0001-01-01T00:00:00+01:00", // before year 1 as an instant
    "2026-10-17T18:11:45Zjunk",
  ])("refuses %j", (text) => {
    expect(parseInstantMicros(text)).toBeNull();
  });
});

describe("canonical forms", () => {
  it("canonicalInstant: offset text to micros, canonical micros through", () => {
    expect(canonicalInstant("2026-10-17T18:11:45.188000-04:00")).toBe(
      "1792275105188000",
    );
    expect(canonicalInstant("0")).toBe("0");
    expect(canonicalInstant("-5")).toBe("-5");
    expect(canonicalInstant("1792275105188000")).toBe("1792275105188000");
    expect(canonicalInstant("007")).toBeNull();
    expect(canonicalInstant("-0")).toBeNull();
    expect(canonicalInstant("2026-10-17T18:11:45")).toBeNull();
    expect(canonicalInstant("2026-10-17")).toBeNull();
  });

  it("canonicalWallclock: naive date-times only, fraction 6 digits or absent", () => {
    expect(canonicalWallclock("2026-10-17T18:11:45")).toBe(
      "2026-10-17T18:11:45",
    );
    expect(canonicalWallclock("2026-10-17 18:11:45")).toBe(
      "2026-10-17T18:11:45",
    );
    expect(canonicalWallclock("2026-10-17T18:11:45.5")).toBe(
      "2026-10-17T18:11:45.500000",
    );
    expect(canonicalWallclock("2026-10-17T18:11:45.1234567")).toBe(
      "2026-10-17T18:11:45.123456",
    );
    expect(canonicalWallclock("2026-10-17T18:11:45Z")).toBeNull();
    expect(canonicalWallclock("2026-10-17T18:11:45-04:00")).toBeNull();
    expect(canonicalWallclock("2026-10-17")).toBeNull();
    expect(canonicalWallclock("2026-02-30T00:00:00")).toBeNull();
  });
});

describe("timeDtype — the one decision", () => {
  const predicates = [...TIME_PREDICATES];

  it("names the nine time predicates", () => {
    expect([...TIME_PREDICATES].sort()).toEqual(
      [
        "created",
        "ctime",
        "dissolved_at",
        "extracted_at",
        "last_active",
        "migrated_at",
        "mtime",
        "summary_generated_at",
        "updated",
      ].sort(),
    );
  });

  it.each(predicates)("%s: offset -> instant", (p) => {
    expect(timeDtype(p, "2026-10-17T18:11:45-04:00")).toBe("instant");
    expect(timeDtype(p, "2026-10-17T22:11:45Z")).toBe("instant");
    expect(timeDtype(p, "2026-10-17T22:11:45.188+00:00")).toBe("instant");
  });

  it.each(predicates)("%s: naive -> wallclock", (p) => {
    expect(timeDtype(p, "2026-10-17T18:11:45")).toBe("wallclock");
    expect(timeDtype(p, "2026-10-17 18:11:45.25")).toBe("wallclock");
  });

  it.each(predicates)("%s: bare date and non-time text stay untyped", (p) => {
    expect(timeDtype(p, "2026-10-17")).toBeUndefined();
    expect(timeDtype(p, "yesterday")).toBeUndefined();
    expect(timeDtype(p, "")).toBeUndefined();
    expect(timeDtype(p, "1792260705")).toBeUndefined();
    expect(timeDtype(p, "2026-13-45T00:00:00Z")).toBeUndefined();
  });

  it.each(["status", "title", "source_path", "raw_hash", "hasTag", "date"])(
    "%s: not a time predicate, never typed",
    (p) => {
      expect(timeDtype(p, "2026-10-17T18:11:45-04:00")).toBeUndefined();
      expect(timeDtype(p, "2026-10-17T18:11:45")).toBeUndefined();
    },
  );
});

describe("literalTarget / retractTargets", () => {
  it("an instant is sent as the offset text with dtype instant", () => {
    expect(literalTarget("mtime", "2026-10-17T22:11:45Z")).toEqual({
      toLiteral: "2026-10-17T22:11:45Z",
      dtype: "instant",
    });
  });

  it("a wallclock is sent canonical with dtype wallclock", () => {
    expect(literalTarget("ctime", "2026-10-17 18:11:45.5")).toEqual({
      toLiteral: "2026-10-17T18:11:45.500000",
      dtype: "wallclock",
    });
  });

  it("untyped stays exactly as given", () => {
    expect(literalTarget("created", "2026-10-17")).toEqual({
      toLiteral: "2026-10-17",
    });
    expect(literalTarget("status", "2026-10-17T22:11:45Z")).toEqual({
      toLiteral: "2026-10-17T22:11:45Z",
    });
  });

  it("a time fact retracts untyped (legacy) and typed", () => {
    expect(retractTargets("mtime", "2026-10-17T18:11:45-04:00")).toEqual([
      { toLiteral: "2026-10-17T18:11:45-04:00" },
      { toLiteral: "2026-10-17T18:11:45-04:00", dtype: "instant" },
    ]);
    expect(retractTargets("ctime", "2026-10-17T18:11:45")).toEqual([
      { toLiteral: "2026-10-17T18:11:45" },
      { toLiteral: "2026-10-17T18:11:45", dtype: "wallclock" },
    ]);
  });

  it("anything else retracts once, as read", () => {
    expect(retractTargets("created", "2026-10-17")).toEqual([
      { toLiteral: "2026-10-17" },
    ]);
    expect(retractTargets("status", "2026-10-17T18:11:45-04:00")).toEqual([
      { toLiteral: "2026-10-17T18:11:45-04:00" },
    ]);
  });
});

describe("sameTime / sameValue / compareTimes", () => {
  it("two spellings of one instant are the same", () => {
    expect(sameTime("2026-10-17T22:11:45Z", "2026-10-17T18:11:45-04:00")).toBe(
      true,
    );
    expect(
      sameTime("2026-10-17T22:11:45.0Z", "2026-10-17T18:11:45.000000-04:00"),
    ).toBe(true);
    expect(sameTime("2026-10-17T22:11:45Z", "2026-10-17T22:11:46Z")).toBe(
      false,
    );
  });

  it("everything else compares as text", () => {
    expect(sameTime("2026-10-17", "2026-10-17")).toBe(true);
    expect(sameTime("2026-10-17T18:11:45", "2026-10-17T22:11:45Z")).toBe(false);
    expect(sameTime("2026-10-17T18:11:45", "2026-10-17T18:11:45")).toBe(true);
    expect(sameTime("a", "b")).toBe(false);
  });

  it("sameValue compares instants only under a time predicate", () => {
    const a = "2026-10-17T22:11:45Z";
    const b = "2026-10-17T18:11:45-04:00";
    expect(sameValue("mtime", a, b)).toBe(true);
    expect(sameValue("note", a, b)).toBe(false);
    expect(sameValue("note", a, a)).toBe(true);
  });

  it("compareTimes orders by instant, not by string", () => {
    // As strings the first sorts after the second; as instants, before.
    const early = "2026-10-17T23:00:00+05:00"; // 18:00Z
    const late = "2026-10-17T15:00:00-04:00"; // 19:00Z
    expect([late, early].sort()).toEqual([late, early]);
    expect(compareTimes(early, late)).toBe(-1);
    expect(compareTimes(late, early)).toBe(1);
    // one instant, two spellings: ordered by text, antisymmetric
    const same = "2026-10-17T18:00:00Z";
    expect(compareTimes(early, same)).toBe(-compareTimes(same, early));
    expect(compareTimes(same, same)).toBe(0);
    // across the DST fold
    expect(
      compareTimes("2026-11-01T01:30:00-04:00", "2026-11-01T01:15:00-05:00"),
    ).toBe(-1);
  });

  it("compareTimes puts unparseable text before any instant, totally", () => {
    expect(compareTimes("", "2026-10-17T18:00:00Z")).toBe(-1);
    expect(compareTimes("2026-10-17T18:00:00Z", "")).toBe(1);
    expect(compareTimes("2026-10-17", "2026-10-18")).toBe(-1);
    expect(compareTimes("x", "x")).toBe(0);
    const sorted = [
      "",
      "2026-10-17T22:00:00Z",
      "2020-01-01",
      "2026-10-17T17:00:00-04:00",
    ].sort(compareTimes);
    expect(sorted).toEqual([
      "",
      "2020-01-01",
      "2026-10-17T17:00:00-04:00",
      "2026-10-17T22:00:00Z",
    ]);
  });
});

describe("renderEastern", () => {
  it.each([
    [1792275105188000n, "2026-10-17T18:11:45.188000-04:00"],
    [1767621600000000n, "2026-01-05T09:00:00-05:00"],
    [0n, "1969-12-31T19:00:00-05:00"],
    [-500000n, "1969-12-31T18:59:59.500000-05:00"],
  ])("%s -> %s", (micros, text) => {
    expect(renderEastern(micros)).toBe(text);
  });

  it("round-trips through parseInstantMicros", () => {
    for (const m of [0n, 1n, -1n, 1792260705188001n, 1783000000999999n]) {
      expect(parseInstantMicros(renderEastern(m))).toBe(m);
    }
  });
});
