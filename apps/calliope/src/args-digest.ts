// The elevation args digest, in TypeScript — vendored from charon
// (apps/server/src/lib/args-digest.ts, the minting side of the calliope_write
// act assertion) so that calliope recomputes the SAME bytes charon bound.
//
// Kept byte-exact with charon's copy, which is itself pinned to vectors
// computed by stellar-core-go `elevation.ArgsDigest`
// (__tests__/fixtures/args-digest-vectors.json, copied verbatim from charon and
// asserted in __tests__/args-digest.test.ts). stellar-core-ts's own
// `argsDigest` is NOT used: it digests a parsed value and so loses an integer
// literal past 2^53, which this reader keeps digit for digit.
//
// A port of stellar-core-go `elevation.ArgsDigest` (themis vendors it at
// vendor/git.notusmi.com/rob/stellar-core-go/elevation/digest.go): the SHA-256,
// in hex, of the CANONICAL JSON of a call's whole argument object with the
// top-level `_stepup` key removed. Absent, empty or `null` arguments digest as
// "{}". Charon recomputes it over the arguments it is about to show Rob, so
// "what Rob approves is what runs" is checked here, not trusted from themis.
//
// CANONICAL, as Go renders it: object keys sorted by their UTF-8 BYTES (not
// UTF-16 code units: they differ for astral characters), no whitespace, no HTML
// escaping, U+2028/2029 escaped, a lone surrogate read as U+FFFD, and numbers
// by value. A number is parsed from its LITERAL, never through a JS double: a
// plain integer literal keeps its digits (two distinct 64-bit ids never
// collapse), any other form that is integral below 2^53 is that integer, and
// the rest is the shortest float64 that round-trips, in Go's `%g` shape
// (`1e-07`, `1.5e+300`; exponent form below 1e-4 and from 1e6 up).
//
// Pinned against vectors computed by the Go code itself:
// __tests__/fixtures/args-digest-vectors.json. If themis's digest changes,
// those vectors change first and this file follows.

import { createHash } from "node:crypto";

/** The argument a retry carries the step-up challenge in; never part of the digest. */
export const STEPUP_KEY = "_stepup";

/** A JSON number held as its literal text. */
export class RawNum {
  constructor(public readonly lit: string) {}
}
export type RawObj = Map<string, Raw>;
export type Raw = null | boolean | string | RawNum | Raw[] | RawObj;

export class DigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigestError";
  }
}

// ---- a strict JSON reader that keeps number literals ----------------------

const WS = new Set([" ", "\t", "\n", "\r"]);
const NUM_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;

class Reader {
  i = 0;
  constructor(private readonly s: string) {}

  ws(): void {
    while (this.i < this.s.length && WS.has(this.s.charAt(this.i))) this.i++;
  }
  done(): boolean {
    this.ws();
    return this.i >= this.s.length;
  }
  fail(what: string): never {
    throw new DigestError(
      `arguments are not JSON: ${what} at ${String(this.i)}`,
    );
  }

  value(): Raw {
    this.ws();
    const c = this.s[this.i];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"') return this.string();
    if (this.s.startsWith("true", this.i)) {
      this.i += 4;
      return true;
    }
    if (this.s.startsWith("false", this.i)) {
      this.i += 5;
      return false;
    }
    if (this.s.startsWith("null", this.i)) {
      this.i += 4;
      return null;
    }
    const m = NUM_RE.exec(this.s.slice(this.i, this.i + 400));
    if (m === null) this.fail("unexpected token");
    this.i += m[0].length;
    return new RawNum(m[0]);
  }

  object(): RawObj {
    const out: RawObj = new Map();
    this.i++;
    this.ws();
    if (this.s[this.i] === "}") {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') this.fail("object key");
      const k = this.string();
      this.ws();
      if (this.s[this.i] !== ":") this.fail("expected ':'");
      this.i++;
      out.set(k, this.value()); // a duplicate key: the last wins, as in Go
      this.ws();
      const c = this.s[this.i++];
      if (c === "}") return out;
      if (c !== ",") this.fail("expected ',' or '}'");
    }
  }

  array(): Raw[] {
    const out: Raw[] = [];
    this.i++;
    this.ws();
    if (this.s[this.i] === "]") {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.ws();
      const c = this.s[this.i++];
      if (c === "]") return out;
      if (c !== ",") this.fail("expected ',' or ']'");
    }
  }

  hex4(): number {
    const h = this.s.slice(this.i, this.i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) this.fail("bad \\u escape");
    this.i += 4;
    return parseInt(h, 16);
  }

  string(): string {
    this.i++;
    let out = "";
    for (;;) {
      if (this.i >= this.s.length) this.fail("unterminated string");
      const c = this.s.charAt(this.i++);
      if (c === '"') return out;
      if (c.charCodeAt(0) < 0x20) this.fail("control character in string");
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.s[this.i++];
      switch (e) {
        case '"':
        case "\\":
        case "/":
          out += e;
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hi = this.hex4();
          if (hi >= 0xd800 && hi < 0xdc00) {
            // A high surrogate pairs only with an immediately following \uDC00-DFFF.
            const next = this.s.slice(this.i, this.i + 6);
            if (/^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(next)) {
              this.i += 2;
              const lo = this.hex4();
              out += String.fromCharCode(hi, lo);
            } else {
              out += "�";
            }
          } else if (hi >= 0xdc00 && hi < 0xe000) {
            out += "�";
          } else {
            out += String.fromCharCode(hi);
          }
          break;
        }
        default:
          this.fail("bad escape");
      }
    }
  }
}

/** Parse JSON text, keeping every number as its literal. Throws DigestError. */
export function parseRaw(text: string): Raw {
  const r = new Reader(text);
  const v = r.value();
  if (!r.done()) throw new DigestError("arguments carry trailing data");
  return v;
}

// ---- canonical rendering ---------------------------------------------------

function utf8(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

function canonString(s: string): string {
  return JSON.stringify(s)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Go's strconv.FormatFloat(f, 'g', -1, 64) for a finite, non-integral-or-large f. */
function goG(f: number): string {
  const sign = f < 0 ? "-" : "";
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(Math.abs(f).toExponential());
  if (m === null)
    throw new DigestError(`number ${String(f)} has no shortest form`);
  const digits = `${m[1] ?? ""}${m[2] ?? ""}`;
  const exp = Number(m[3]);
  if (exp < -4 || exp >= 6) {
    const mant =
      digits.length > 1 ? `${digits.slice(0, 1)}.${digits.slice(1)}` : digits;
    const ae = Math.abs(exp);
    return `${sign}${mant}e${exp < 0 ? "-" : "+"}${ae < 10 ? "0" : ""}${String(ae)}`;
  }
  if (exp >= 0) {
    const int = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
    const frac = digits.slice(exp + 1);
    return `${sign}${int}${frac === "" ? "" : `.${frac}`}`;
  }
  return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
}

function canonNumber(lit: string): string {
  if (/^-?[0-9]+$/.test(lit)) return lit === "-0" ? "0" : lit;
  const f = Number(lit);
  if (!Number.isFinite(f)) {
    throw new DigestError(`number "${lit}" is outside float64`);
  }
  if (f === 0) return "0";
  if (Number.isInteger(f) && Math.abs(f) < 2 ** 53) return String(f);
  return goG(f);
}

function writeCanonical(v: Raw): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return canonString(v);
  if (v instanceof RawNum) return canonNumber(v.lit);
  if (Array.isArray(v)) return `[${v.map(writeCanonical).join(",")}]`;
  const keys = [...v.keys()].sort((a, b) => Buffer.compare(utf8(a), utf8(b)));
  return `{${keys
    .map((k) => `${canonString(k)}:${writeCanonical(v.get(k) as Raw)}`)
    .join(",")}}`;
}

/** The canonical JSON of an argument object (text or parsed), `_stepup` removed. */
export function canonicalArgs(input: string | Raw): string {
  let v: Raw;
  if (typeof input === "string") {
    if (input.trim() === "") return "{}";
    v = parseRaw(input);
  } else {
    v = input;
  }
  if (v === null) return "{}"; // a literal null is no arguments
  if (typeof v !== "object" || Array.isArray(v) || v instanceof RawNum) {
    throw new DigestError("arguments are not a JSON object");
  }
  const copy: RawObj = new Map(v);
  copy.delete(STEPUP_KEY);
  return writeCanonical(copy);
}

/** The elevation digest of an argument object: sha256 hex of its canonical JSON. */
export function argsDigest(input: string | Raw): string {
  return createHash("sha256").update(canonicalArgs(input)).digest("hex");
}
