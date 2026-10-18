/**
 * RFC 3339 instants on the wire. Several answer-schema fields are
 * `format: "date-time"`, and the MCP client validates them (Ajv with
 * ajv-formats): a date, `T`, a time and a REQUIRED `Z` or `±HH:MM` offset.
 * Anything else fails the whole tool call, so a value this star did not mint
 * itself is checked here before it is emitted.
 */

import type { EdgeTarget } from "./chaos-client.js";

const TEXT =
  /^(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})[Tt ](?<h>\d{2}):(?<mi>\d{2}):(?<s>\d{2})(?<frac>\.\d+)?(?<off>[Zz]|[+-]\d{2}(?::?\d{2})?)$/;

function calendarHolds(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
): boolean {
  const at = new Date(Date.UTC(y, mo - 1, d));
  return (
    at.getUTCFullYear() === y &&
    at.getUTCMonth() === mo - 1 &&
    at.getUTCDate() === d &&
    h <= 23 &&
    mi <= 59 &&
    s <= 60
  );
}

/**
 * The text as a date-time Ajv accepts, or null when it names no instant.
 * Postgres's text cast of a timestamptz (`2026-08-01 09:15:00.5-04`: a space,
 * and an offset of hours only) is normalised, keeping the instant and its
 * offset; an offset-less text is null, never assumed to be UTC.
 */
export function asDateTime(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const m = TEXT.exec(text);
  if (m === null) return null;
  const g = m.groups as Record<
    "y" | "mo" | "d" | "h" | "mi" | "s" | "off",
    string
  > &
    Partial<Record<"frac", string>>;
  const { y, mo, d, h, mi, s, frac, off } = g;
  if (
    !calendarHolds(
      Number(y),
      Number(mo),
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
    )
  ) {
    return null;
  }
  let offset = off.toUpperCase();
  if (offset !== "Z") {
    const digits = offset.slice(1).replace(":", "");
    const hh = digits.slice(0, 2);
    const mm = digits.length > 2 ? digits.slice(2) : "00";
    if (Number(hh) > 23 || Number(mm) > 59) return null;
    offset = `${offset.slice(0, 1)}${hh}:${mm}`;
  }
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${frac ?? ""}${offset}`;
}

/** Whether the text already is a date-time the client accepts, as written. */
export function isDateTime(text: unknown): text is string {
  return typeof text === "string" && asDateTime(text) === text;
}

/**
 * Time facts in the notes graph (aiws:chaos-addressing@0.2.0, R-CA15..R-CA20).
 *
 * A time predicate's value is written with a dtype, never as bare text:
 *
 *  - an offset-bearing date-time (`Z`, `+00:00`, `-04:00`) is an INSTANT.
 *    chaos stores canonical epoch microseconds and answers every read
 *    rendered as America/New_York RFC 3339 with an explicit offset;
 *  - a naive date-time is a WALLCLOCK (the zone is unknown): stored and
 *    answered verbatim as `YYYY-MM-DDTHH:MM:SS[.ffffff]`;
 *  - a bare date (`YYYY-MM-DD`) and any non-time text stay untyped.
 *
 * {@link timeDtype} is the ONE place that decides. Everything else here is
 * the arithmetic a reader or a retractor needs, because a read answers only
 * the rendering: the stored form is not the text read back, so an
 * equality check, a sort or a retract must go through the parsed instant.
 *
 * stellar-core-ts 0.74.0 (calliope's pin) does not export `timefmt`, so the
 * small canonicalisation is inline: exact, floored to the microsecond.
 */

/** Predicates whose value is a time fact when it is a date-time. */
export const TIME_PREDICATES: ReadonlySet<string> = new Set([
  "mtime",
  "ctime",
  "dissolved_at",
  "extracted_at",
  "migrated_at",
  "last_active",
  "summary_generated_at",
  "created",
  "updated",
]);

export type TimeDtype = "instant" | "wallclock";

const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2})(?::?(\d{2}))?)?$/;
const CANONICAL_MICROS = /^(?:0|-?[1-9][0-9]*)$/;
const MICRO = 1_000_000n;
/** 0001-01-01T00:00:00Z and 9999-12-31T23:59:59.999999Z, in microseconds. */
const MIN_MICROS = -62135596800000000n;
const MAX_MICROS = 253402300799999999n;

const isLeap = (y: number): boolean =>
  (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function monthDays(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** Days since 1970-01-01 of a proleptic-Gregorian civil date. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** A date-time text, split: its offset (seconds) when it has one. */
interface Scanned {
  local: bigint; // microseconds of the local civil time, as if UTC
  fraction: string; // the fraction digits cut to 6, "" when absent
  stamp: string; // YYYY-MM-DDTHH:MM:SS (the naive canonical head)
  offset: number | null;
}

function scan(text: string): Scanned | null {
  const m = DATE_TIME.exec(text);
  if (m === null) return null;
  const num = (i: number): number => Number(m[i] ?? "0");
  const [year, month, day] = [num(1), num(2), num(3)];
  const [hour, minute, second] = [num(4), num(5), num(6)];
  const hasOffset = m[8] !== undefined || m[9] !== undefined;
  const offH = num(10);
  const offM = num(11);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offH > 23 ||
    offM > 59
  ) {
    return null;
  }
  const fraction = (m[7] ?? "").slice(0, 6);
  const micros = BigInt(fraction.padEnd(6, "0") || "0");
  const secs =
    daysFromCivil(year, month, day) * 86400 +
    hour * 3600 +
    minute * 60 +
    second;
  const sign = m[9] === "-" ? -1 : 1;
  const pad = (n: number, w: number): string => String(n).padStart(w, "0");
  return {
    local: BigInt(secs) * MICRO + micros,
    fraction,
    stamp:
      `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T` +
      `${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`,
    offset: hasOffset
      ? m[8] !== undefined
        ? 0
        : sign * (offH * 3600 + offM * 60)
      : null,
  };
}

/**
 * Epoch microseconds (floored) of an OFFSET-BEARING date-time, or null for
 * naive text, a bare date, anything else, or an instant out of the 0001..9999
 * domain.
 */
export function parseInstantMicros(text: string): bigint | null {
  const s = scan(text);
  if (s === null) return null;
  if (s.offset === null) return null;
  const micros = s.local - BigInt(s.offset) * MICRO;
  return micros >= MIN_MICROS && micros <= MAX_MICROS ? micros : null;
}

/** The canonical decimal-microseconds form of an offset-bearing date-time
 *  (or of text that is already canonical µs); null otherwise. */
export function canonicalInstant(text: string): string | null {
  const micros = parseInstantMicros(text);
  if (micros !== null) return micros.toString();
  return CANONICAL_MICROS.test(text) ? text : null;
}

/** The canonical wallclock `YYYY-MM-DDTHH:MM:SS[.ffffff]` of a NAIVE
 *  date-time, or null. */
export function canonicalWallclock(text: string): string | null {
  const s = scan(text);
  if (s === null) return null;
  if (s.offset !== null) return null;
  return s.fraction === ""
    ? s.stamp
    : `${s.stamp}.${s.fraction.padEnd(6, "0")}`;
}

/**
 * THE decision: the dtype a write of `value` under `predicate` carries.
 * Undefined means untyped, unchanged (not a time predicate, a bare date,
 * non-time text).
 */
export function timeDtype(
  predicate: string,
  value: string,
): TimeDtype | undefined {
  if (!TIME_PREDICATES.has(predicate)) return undefined;
  if (parseInstantMicros(value) !== null) return "instant";
  if (canonicalWallclock(value) !== null) return "wallclock";
  return undefined;
}

/** The literal target for a write of `value` under `predicate`: typed when
 *  it is a time fact, else the bare literal. A wallclock goes in canonical
 *  form; an instant goes as the offset-bearing text (themis normalises it). */
export function literalTarget(predicate: string, value: string): EdgeTarget {
  const dtype = timeDtype(predicate, value);
  if (dtype === undefined) return { toLiteral: value };
  return {
    toLiteral:
      dtype === "wallclock" ? (canonicalWallclock(value) ?? value) : value,
    dtype,
  };
}

/**
 * Every literal target that retracts a fact read back as `value`: the
 * read-back text untyped (a legacy fact), plus, for a time fact, the same
 * text typed (an instant fact is stored as µs, not as the rendering read).
 * A retract of an absent fact is a no-op in chaos.
 */
export function retractTargets(predicate: string, value: string): EdgeTarget[] {
  const out: EdgeTarget[] = [{ toLiteral: value }];
  const typed = literalTarget(predicate, value);
  if (typed.dtype !== undefined) out.push(typed);
  return out;
}

/**
 * Do a held value and a wanted value say the same thing? Instants compare as
 * instants when BOTH parse offset-bearing; everything else compares as text.
 */
export function sameTime(a: string, b: string): boolean {
  const ma = parseInstantMicros(a);
  const mb = parseInstantMicros(b);
  return ma !== null && mb !== null ? ma === mb : a === b;
}

/** {@link sameTime} for a predicate: only time predicates compare as instants. */
export function sameValue(predicate: string, a: string, b: string): boolean {
  return TIME_PREDICATES.has(predicate) ? sameTime(a, b) : a === b;
}

/**
 * Order two time texts by their instant (ascending). Unparseable or naive
 * text sorts before any instant; ties fall back to the text so the order is
 * total and stable.
 */
export function compareTimes(a: string, b: string): number {
  const ma = parseInstantMicros(a);
  const mb = parseInstantMicros(b);
  if (ma !== null && mb !== null && ma !== mb) return ma < mb ? -1 : 1;
  if (ma !== null && mb === null) return 1;
  if (ma === null && mb !== null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

const EASTERN = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * How chaos answers a stored instant: America/New_York RFC 3339 with an
 * explicit offset (never Z), the fraction 6 digits or absent. The fixture
 * dial and the tests use it to stand in for chaos's read verbs.
 */
export function renderEastern(micros: bigint): string {
  const whole = micros / MICRO - (micros % MICRO < 0n ? 1n : 0n);
  const frac = Number(micros - whole * MICRO);
  const utcMs = Number(whole) * 1000;
  const parts: Record<string, string> = {};
  for (const part of EASTERN.formatToParts(new Date(utcMs))) {
    parts[part.type] = part.value;
  }
  const p = (type: string): string => parts[type] ?? "";
  const localMs = Date.UTC(
    Number(p("year")),
    Number(p("month")) - 1,
    Number(p("day")),
    Number(p("hour")),
    Number(p("minute")),
    Number(p("second")),
  );
  const offMin = Math.round((localMs - utcMs) / 60000);
  const sign = offMin < 0 ? "-" : "+";
  const abs = Math.abs(offMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const fraction = frac === 0 ? "" : `.${String(frac).padStart(6, "0")}`;
  return (
    `${p("year")}-${p("month")}-${p("day")}T` +
    `${p("hour")}:${p("minute")}:${p("second")}` +
    `${fraction}${sign}${hh}:${mm}`
  );
}
