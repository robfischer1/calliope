/**
 * RFC 3339 instants on the wire. Several answer-schema fields are
 * `format: "date-time"`, and the MCP client validates them (Ajv with
 * ajv-formats): a date, `T`, a time and a REQUIRED `Z` or `±HH:MM` offset.
 * Anything else fails the whole tool call, so a value this star did not mint
 * itself is checked here before it is emitted.
 */

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
