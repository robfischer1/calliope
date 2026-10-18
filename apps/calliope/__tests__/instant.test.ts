import { describe, expect, it } from "vitest";
import { asDateTime, isDateTime } from "../src/instant.js";

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
