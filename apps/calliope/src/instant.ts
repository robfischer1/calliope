/** //p
 * RFC 3339 instants on the wire. Several answer-schema fields are //p
 * `format: "date-time"`, and the MCP client validates them (Ajv with //p
 * ajv-formats): a date, `T`, a time and a REQUIRED `Z` or `±HH:MM` offset. //p
 * Anything else fails the whole tool call, so a value this star did not mint //p
 * itself is checked here before it is emitted. //p
 */ //p

import type { EdgeTarget } from "./chaos-client.js"; //p

const TEXT = //p
  /^(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})[Tt ](?<h>\d{2}):(?<mi>\d{2}):(?<s>\d{2})(?<frac>\.\d+)?(?<off>[Zz]|[+-]\d{2}(?::?\d{2})?)$/; //p

function calendarHolds( //p
  y: number, //p
  mo: number, //p
  d: number, //p
  h: number, //p
  mi: number, //p
  s: number, //p
): boolean { //p
  const at = new Date(Date.UTC(y, mo - 1, d)); //p
  return ( //p
    at.getUTCFullYear() === y && //p
    at.getUTCMonth() === mo - 1 && //p
    at.getUTCDate() === d && //p
    h <= 23 && //p
    mi <= 59 && //p
    s <= 60 //p
  ); //p
} //p

/** //p
 * The text as a date-time Ajv accepts, or null when it names no instant. //p
 * Postgres's text cast of a timestamptz (`2026-08-01 09:15:00.5-04`: a space, //p
 * and an offset of hours only) is normalised, keeping the instant and its //p
 * offset; an offset-less text is null, never assumed to be UTC. //p
 */ //p
export function asDateTime(text: string | null | undefined): string | null { //p
  if (typeof text !== "string") return null; //p
  const m = TEXT.exec(text); //p
  if (m === null) return null; //p
  const g = m.groups as Record< //p
    "y" | "mo" | "d" | "h" | "mi" | "s" | "off", //p
    string //p
  > & //p
    Partial<Record<"frac", string>>; //p
  const { y, mo, d, h, mi, s, frac, off } = g; //p
  if ( //p
    !calendarHolds( //p
      Number(y), //p
      Number(mo), //p
      Number(d), //p
      Number(h), //p
      Number(mi), //p
      Number(s), //p
    ) //p
  ) { //p
    return null; //p
  } //p
  let offset = off.toUpperCase(); //p
  if (offset !== "Z") { //p
    const digits = offset.slice(1).replace(":", ""); //p
    const hh = digits.slice(0, 2); //p
    const mm = digits.length > 2 ? digits.slice(2) : "00"; //p
    if (Number(hh) > 23 || Number(mm) > 59) return null; //p
    offset = `${offset.slice(0, 1)}${hh}:${mm}`; //p
  } //p
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${frac ?? ""}${offset}`; //p
} //p

/** Whether the text already is a date-time the client accepts, as written. */ //p
export function isDateTime(text: unknown): text is string { //p
  return typeof text === "string" && asDateTime(text) === text; //p
} //p

/** //p
 * Time facts in the notes graph (aiws:chaos-addressing@0.2.0, R-CA15..R-CA20). //p
 * //p
 * A time predicate's value is written with a dtype, never as bare text: //p
 * //p
 *  - an offset-bearing date-time (`Z`, `+00:00`, `-04:00`) is an INSTANT. //p
 *    chaos stores canonical epoch microseconds and answers every read //p
 *    rendered as America/New_York RFC 3339 with an explicit offset; //p
 *  - a naive date-time is a WALLCLOCK (the zone is unknown): stored and //p
 *    answered verbatim as `YYYY-MM-DDTHH:MM:SS[.ffffff]`; //p
 *  - a bare date (`YYYY-MM-DD`) and any non-time text stay untyped. //p
 * //p
 * {@link timeDtype} is the ONE place that decides. Everything else here is //p
 * the arithmetic a reader or a retractor needs, because a read answers only //p
 * the rendering: the stored form is not the text read back, so an //p
 * equality check, a sort or a retract must go through the parsed instant. //p
 * //p
 * stellar-core-ts 0.74.0 (calliope's pin) does not export `timefmt`, so the //p
 * small canonicalisation is inline: exact, floored to the microsecond. //p
 */ //p

/** Predicates whose value is a time fact when it is a date-time. */ //p
export const TIME_PREDICATES: ReadonlySet<string> = new Set([ //p
  "mtime", //p
  "ctime", //p
  "dissolved_at", //p
  "extracted_at", //p
  "migrated_at", //p
  "last_active", //p
  "summary_generated_at", //p
  "created", //p
  "updated", //p
]); //p

export type TimeDtype = "instant" | "wallclock"; //p

const DATE_TIME = //p
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2})(?::?(\d{2}))?)?$/; //p
const CANONICAL_MICROS = /^(?:0|-?[1-9][0-9]*)$/; //p
const MICRO = 1_000_000n; //p
/** 0001-01-01T00:00:00Z and 9999-12-31T23:59:59.999999Z, in microseconds. */ //p
const MIN_MICROS = -62135596800000000n; //p
const MAX_MICROS = 253402300799999999n; //p

const isLeap = (y: number): boolean => //p
  (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; //p

function monthDays(y: number, m: number): number { //p
  if (m === 2) return isLeap(y) ? 29 : 28; //p
  return [4, 6, 9, 11].includes(m) ? 30 : 31; //p
} //p

/** Days since 1970-01-01 of a proleptic-Gregorian civil date. */ //p
function daysFromCivil(y: number, m: number, d: number): number { //p
  const yy = m <= 2 ? y - 1 : y; //p
  const era = Math.floor(yy / 400); //p
  const yoe = yy - era * 400; //p
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1; //p
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; //p
  return era * 146097 + doe - 719468; //p
} //p

/** A date-time text, split: its offset (seconds) when it has one. */ //p
interface Scanned { //p
  local: bigint; // microseconds of the local civil time, as if UTC //p
  fraction: string; // the fraction digits cut to 6, "" when absent //p
  stamp: string; // YYYY-MM-DDTHH:MM:SS (the naive canonical head) //p
  offset: number | null; //p
} //p

function scan(text: string): Scanned | null { //p
  const m = DATE_TIME.exec(text); //p
  if (m === null) return null; //p
  const num = (i: number): number => Number(m[i] ?? "0"); //p
  const [year, month, day] = [num(1), num(2), num(3)]; //p
  const [hour, minute, second] = [num(4), num(5), num(6)]; //p
  const hasOffset = m[8] !== undefined || m[9] !== undefined; //p
  const offH = num(10); //p
  const offM = num(11); //p
  if ( //p
    year < 1 || //p
    month < 1 || //p
    month > 12 || //p
    day < 1 || //p
    day > monthDays(year, month) || //p
    hour > 23 || //p
    minute > 59 || //p
    second > 59 || //p
    offH > 23 || //p
    offM > 59 //p
  ) { //p
    return null; //p
  } //p
  const fraction = (m[7] ?? "").slice(0, 6); //p
  const micros = BigInt(fraction.padEnd(6, "0") || "0"); //p
  const secs = //p
    daysFromCivil(year, month, day) * 86400 + //p
    hour * 3600 + //p
    minute * 60 + //p
    second; //p
  const sign = m[9] === "-" ? -1 : 1; //p
  const pad = (n: number, w: number): string => String(n).padStart(w, "0"); //p
  return { //p
    local: BigInt(secs) * MICRO + micros, //p
    fraction, //p
    stamp: //p
      `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T` + //p
      `${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`, //p
    offset: hasOffset //p
      ? m[8] !== undefined //p
        ? 0 //p
        : sign * (offH * 3600 + offM * 60) //p
      : null, //p
  }; //p
} //p

/** //p
 * Epoch microseconds (floored) of an OFFSET-BEARING date-time, or null for //p
 * naive text, a bare date, anything else, or an instant out of the 0001..9999 //p
 * domain. //p
 */ //p
export function parseInstantMicros(text: string): bigint | null { //p
  const s = scan(text); //p
  if (s === null) return null; //p
  if (s.offset === null) return null; //p
  const micros = s.local - BigInt(s.offset) * MICRO; //p
  return micros >= MIN_MICROS && micros <= MAX_MICROS ? micros : null; //p
} //p

/** The canonical decimal-microseconds form of an offset-bearing date-time //p
 *  (or of text that is already canonical µs); null otherwise. */ //p
export function canonicalInstant(text: string): string | null { //p
  const micros = parseInstantMicros(text); //p
  if (micros !== null) return micros.toString(); //p
  return CANONICAL_MICROS.test(text) ? text : null; //p
} //p

/** The canonical wallclock `YYYY-MM-DDTHH:MM:SS[.ffffff]` of a NAIVE //p
 *  date-time, or null. */ //p
export function canonicalWallclock(text: string): string | null { //p
  const s = scan(text); //p
  if (s === null) return null; //p
  if (s.offset !== null) return null; //p
  return s.fraction === "" //p
    ? s.stamp //p
    : `${s.stamp}.${s.fraction.padEnd(6, "0")}`; //p
} //p

/** //p
 * THE decision: the dtype a write of `value` under `predicate` carries. //p
 * Undefined means untyped, unchanged (not a time predicate, a bare date, //p
 * non-time text). //p
 */ //p
export function timeDtype( //p
  predicate: string, //p
  value: string, //p
): TimeDtype | undefined { //p
  if (!TIME_PREDICATES.has(predicate)) return undefined; //p
  if (parseInstantMicros(value) !== null) return "instant"; //p
  if (canonicalWallclock(value) !== null) return "wallclock"; //p
  return undefined; //p
} //p

/** The literal target for a write of `value` under `predicate`: typed when //p
 *  it is a time fact, else the bare literal. A wallclock goes in canonical //p
 *  form; an instant goes as the offset-bearing text (themis normalises it). */ //p
export function literalTarget(predicate: string, value: string): EdgeTarget { //p
  const dtype = timeDtype(predicate, value); //p
  if (dtype === undefined) return { toLiteral: value }; //p
  return { //p
    toLiteral: //p
      dtype === "wallclock" ? (canonicalWallclock(value) ?? value) : value, //p
    dtype, //p
  }; //p
} //p

/** //p
 * Every literal target that retracts a fact read back as `value`: the //p
 * read-back text untyped (a legacy fact), plus, for a time fact, the same //p
 * text typed (an instant fact is stored as µs, not as the rendering read). //p
 * A retract of an absent fact is a no-op in chaos. //p
 */ //p
export function retractTargets(predicate: string, value: string): EdgeTarget[] { //p
  const out: EdgeTarget[] = [{ toLiteral: value }]; //p
  const typed = literalTarget(predicate, value); //p
  if (typed.dtype !== undefined) out.push(typed); //p
  return out; //p
} //p

/** //p
 * Do a held value and a wanted value say the same thing? Instants compare as //p
 * instants when BOTH parse offset-bearing; everything else compares as text. //p
 */ //p
export function sameTime(a: string, b: string): boolean { //p
  const ma = parseInstantMicros(a); //p
  const mb = parseInstantMicros(b); //p
  return ma !== null && mb !== null ? ma === mb : a === b; //p
} //p

/** {@link sameTime} for a predicate: only time predicates compare as instants. */ //p
export function sameValue(predicate: string, a: string, b: string): boolean { //p
  return TIME_PREDICATES.has(predicate) ? sameTime(a, b) : a === b; //p
} //p

/** //p
 * Order two time texts by their instant (ascending). Unparseable or naive //p
 * text sorts before any instant; ties fall back to the text so the order is //p
 * total and stable. //p
 */ //p
export function compareTimes(a: string, b: string): number { //p
  const ma = parseInstantMicros(a); //p
  const mb = parseInstantMicros(b); //p
  if (ma !== null && mb !== null && ma !== mb) return ma < mb ? -1 : 1; //p
  if (ma !== null && mb === null) return 1; //p
  if (ma === null && mb !== null) return -1; //p
  return a < b ? -1 : a > b ? 1 : 0; //p
} //p

const EASTERN = new Intl.DateTimeFormat("en-US", { //p
  timeZone: "America/New_York", //p
  hourCycle: "h23", //p
  year: "numeric", //p
  month: "2-digit", //p
  day: "2-digit", //p
  hour: "2-digit", //p
  minute: "2-digit", //p
  second: "2-digit", //p
}); //p

/** //p
 * How chaos answers a stored instant: America/New_York RFC 3339 with an //p
 * explicit offset (never Z), the fraction 6 digits or absent. The fixture //p
 * dial and the tests use it to stand in for chaos's read verbs. //p
 */ //p
export function renderEastern(micros: bigint): string { //p
  const whole = micros / MICRO - (micros % MICRO < 0n ? 1n : 0n); //p
  const frac = Number(micros - whole * MICRO); //p
  const utcMs = Number(whole) * 1000; //p
  const parts: Record<string, string> = {}; //p
  for (const part of EASTERN.formatToParts(new Date(utcMs))) { //p
    parts[part.type] = part.value; //p
  } //p
  const p = (type: string): string => parts[type] ?? ""; //p
  const localMs = Date.UTC( //p
    Number(p("year")), //p
    Number(p("month")) - 1, //p
    Number(p("day")), //p
    Number(p("hour")), //p
    Number(p("minute")), //p
    Number(p("second")), //p
  ); //p
  const offMin = Math.round((localMs - utcMs) / 60000); //p
  const sign = offMin < 0 ? "-" : "+"; //p
  const abs = Math.abs(offMin); //p
  const hh = String(Math.floor(abs / 60)).padStart(2, "0"); //p
  const mm = String(abs % 60).padStart(2, "0"); //p
  const fraction = frac === 0 ? "" : `.${String(frac).padStart(6, "0")}`; //p
  return ( //p
    `${p("year")}-${p("month")}-${p("day")}T` + //p
    `${p("hour")}:${p("minute")}:${p("second")}` + //p
    `${fraction}${sign}${hh}:${mm}` //p
  ); //p
} //p
