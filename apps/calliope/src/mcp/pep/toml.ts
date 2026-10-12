/**
 * The slice of TOML the composed orbit sidecar is written in.
 *
 * The sidecar is generated (foundry-tools orbitcompose), never hand-written,
 * and its dialect is small: comments, `[[array]]` blocks, and `key = value`
 * lines whose value is a string, a number, a boolean or an array of those. This
 * reads exactly that and REFUSES everything else (dotted keys, inline tables,
 * multi-line strings, dates), because an ACL that quietly misreads a grant would
 * show up, once enforced, as a refusal nobody declared. Go decodes the sidecar
 * with a full TOML library; a document outside this dialect is a parse error
 * here, which the boot turns into a refused start.
 *
 * A dependency for this would cost more than the ~120 lines below, and the
 * dialect it must refuse is as load-bearing as the one it accepts.
 */

export type TomlValue = string | number | boolean | readonly TomlValue[];
export type TomlTable = ReadonlyMap<string, TomlValue>;

/** The sidecar is not valid (in this dialect of) TOML. */
export class TomlError extends Error {
  constructor(message: string, line: number) {
    super(`line ${String(line)}: ${message}`);
    this.name = "TomlError";
  }
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const NUMBER = /^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?$/;
const ESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

class Cursor {
  i = 0;
  constructor(readonly s: string) {}

  get line(): number {
    return this.s.slice(0, this.i).split("\n").length;
  }
  get eof(): boolean {
    return this.i >= this.s.length;
  }
  peek(offset = 0): string {
    return this.s[this.i + offset] ?? "";
  }
  fail(message: string): never {
    throw new TomlError(message, this.line);
  }
  /** Spaces and tabs only. */
  skipInline(): void {
    while (this.peek() === " " || this.peek() === "\t") this.i += 1;
  }
  /** Everything between tokens: whitespace, newlines and comments. */
  skipBlank(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i += 1;
      else if (c === "#") this.skipComment();
      else return;
    }
  }
  skipComment(): void {
    while (!this.eof && this.peek() !== "\n") this.i += 1;
  }
  expect(token: string): void {
    if (!this.s.startsWith(token, this.i)) this.fail(`expected '${token}'`);
    this.i += token.length;
  }
  /** After a statement: only a comment may share its line. */
  endOfLine(): void {
    this.skipInline();
    if (this.peek() === "#") this.skipComment();
    if (!this.eof && this.peek() !== "\n" && this.peek() !== "\r") {
      this.fail("unexpected text after the statement");
    }
  }
}

function readKey(c: Cursor): string {
  if (c.peek() === '"') return readBasicString(c);
  const start = c.i;
  while (/[A-Za-z0-9_-]/.test(c.peek())) c.i += 1;
  const key = c.s.slice(start, c.i);
  if (!BARE_KEY.test(key)) c.fail("expected a key");
  if (c.peek() === ".") c.fail("dotted keys are not supported");
  return key;
}

function readBasicString(c: Cursor): string {
  if (c.s.startsWith('"""', c.i))
    c.fail("multi-line strings are not supported");
  c.expect('"');
  let out = "";
  for (;;) {
    const ch = c.peek();
    if (ch === "" || ch === "\n") c.fail("unterminated string");
    c.i += 1;
    if (ch === '"') return out;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const esc = c.peek();
    c.i += 1;
    const simple = ESCAPES[esc];
    if (simple !== undefined) {
      out += simple;
    } else if (esc === "u" || esc === "U") {
      const width = esc === "u" ? 4 : 8;
      const hex = c.s.slice(c.i, c.i + width);
      if (!new RegExp(`^[0-9A-Fa-f]{${String(width)}}$`).test(hex)) {
        c.fail("bad unicode escape");
      }
      c.i += width;
      out += String.fromCodePoint(parseInt(hex, 16));
    } else {
      c.fail("bad escape in string");
    }
  }
}

function readLiteralString(c: Cursor): string {
  if (c.s.startsWith("'''", c.i))
    c.fail("multi-line strings are not supported");
  c.expect("'");
  const end = c.s.indexOf("'", c.i);
  const body = end < 0 ? "" : c.s.slice(c.i, end);
  if (end < 0 || body.includes("\n")) c.fail("unterminated string");
  c.i = end + 1;
  return body;
}

function readArray(c: Cursor): TomlValue[] {
  c.expect("[");
  const items: TomlValue[] = [];
  for (;;) {
    c.skipBlank();
    if (c.peek() === "]") {
      c.i += 1;
      return items;
    }
    items.push(readValue(c));
    c.skipBlank();
    if (c.peek() === ",") c.i += 1;
    else if (c.peek() !== "]") c.fail("expected ',' or ']' in an array");
  }
}

function readValue(c: Cursor): TomlValue {
  const ch = c.peek();
  if (ch === '"') return readBasicString(c);
  if (ch === "'") return readLiteralString(c);
  if (ch === "[") return readArray(c);
  if (ch === "{") c.fail("inline tables are not supported");
  const start = c.i;
  while (!/[\s,\]#]/.test(c.peek()) && !c.eof) c.i += 1;
  const token = c.s.slice(start, c.i);
  if (token === "true") return true;
  if (token === "false") return false;
  if (NUMBER.test(token)) return Number(token.replaceAll("_", ""));
  return c.fail(`unsupported value '${token}'`);
}

/**
 * The `[[name]]` blocks of a document, by name, in order. Keys outside a block
 * and `[table]` sections are read (so they must be well-formed) and dropped;
 * the one table the caller cares about being an array is its to check
 * ({@link plainTables}).
 */
export interface TomlDoc {
  readonly arrays: ReadonlyMap<string, readonly TomlTable[]>;
  /** Names of plain `[name]` tables, so a caller can refuse one in an array's place. */
  readonly plainTables: ReadonlySet<string>;
}

export function parseToml(text: string): TomlDoc {
  const c = new Cursor(text);
  const arrays = new Map<string, TomlTable[]>();
  const plainTables = new Set<string>();
  let current = new Map<string, TomlValue>();
  for (;;) {
    c.skipBlank();
    if (c.eof) break;
    if (c.peek() === "[") {
      const isArray = c.peek(1) === "[";
      c.i += isArray ? 2 : 1;
      c.skipInline();
      const name = readKey(c);
      c.skipInline();
      c.expect(isArray ? "]]" : "]");
      c.endOfLine();
      current = new Map();
      if (isArray) arrays.set(name, [...(arrays.get(name) ?? []), current]);
      else plainTables.add(name);
      continue;
    }
    const key = readKey(c);
    c.skipInline();
    c.expect("=");
    c.skipInline();
    const value = readValue(c);
    c.endOfLine();
    if (current.has(key)) c.fail(`duplicate key '${key}'`);
    current.set(key, value);
  }
  return { arrays, plainTables };
}
