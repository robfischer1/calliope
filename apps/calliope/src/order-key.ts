/**
 * Fractional order keys.
 *
 * The substrate stores section ordering as an `order_key` literal sorted as raw
 * bytes (COLLATE "C"), not numerically. A fractional key scheme lets a new key
 * be minted strictly between any two existing keys without renumbering — the
 * property a body editor needs for insert/reorder.
 *
 * The alphabet is the printable ASCII digits `0-9`, whose byte order matches
 * their lexicographic order, so a plain string compare reproduces COLLATE "C".
 * `between(a, b)` returns a key `k` with `a < k < b` byte-wise; `a`/`b` may be
 * unbounded (`null`). A coarse save lays a fresh evenly-spaced sequence via
 * {@link sequence}; finer insert/reorder is the deferred chunking task's job.
 */

const FIRST = "1";
const LAST = "9";
const MID = "5";

/** Byte-wise (COLLATE "C") string compare: -1, 0, or 1. */
export function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * A key strictly between `a` and `b` (byte order). `null` means unbounded:
 * `between(null, b)` yields a key below `b`, `between(a, null)` a key above `a`,
 * `between(null, null)` the canonical first key.
 *
 * Implemented with a fixed digit alphabet `0..9`. To stay strictly between two
 * adjacent keys we append/extend rather than risk a collision: the result is
 * always longer-or-equal and provably ordered.
 */
export function between(a: string | null, b: string | null): string {
  if (a === null) {
    return b === null ? MID : keyBelow(b);
  }
  if (b === null) return keyAbove(a);
  if (compareKeys(a, b) >= 0) {
    throw new Error(`between(): keys not strictly ordered: ${a} >= ${b}`);
  }
  return midpoint(a, b);
}

/** A key strictly below `b`.
 *
 * `sequence()` zero-pads ("01", "02", …), so keys legitimately start below
 * FIRST; the old fallback (`FIRST + FIRST`) returned a key ABOVE such a `b` —
 * the prepend-at-top case was broken for every sequence-minted key (found by
 * the G2 fs-client suite). Descend digit-wise instead. */
function keyBelow(b: string): string {
  const head = b[0] ?? LAST;
  if (head > "0") {
    // A single digit one below the leading digit sorts before b (the "0" pad
    // digit is byte-ordered below FIRST and equally valid).
    return String.fromCharCode(head.charCodeAt(0) - 1);
  }
  const tail = b.slice(1);
  if (tail === "" || /^0+$/.test(tail)) {
    // An all-zero key: one char shorter still sorts strictly below.
    if (b.length <= 1) {
      throw new Error(`between(): no key below the floor key "${b}"`);
    }
    return b.slice(0, -1);
  }
  return `0${keyBelow(tail)}`;
}

/** A key strictly above `a`. */
function keyAbove(a: string): string {
  const head = a[0] ?? FIRST;
  if (head < LAST) {
    return String.fromCharCode(head.charCodeAt(0) + 1);
  }
  // a starts at the ceiling; extend it so the result sorts after a.
  return a + MID;
}

/** A key strictly between two ordered keys, by digit-wise descent. */
function midpoint(a: string, b: string): string {
  let i = 0;
  let prefix = "";
  for (;;) {
    const da = a.charCodeAt(i);
    const db = b.charCodeAt(i);
    const ca = Number.isNaN(da) ? FIRST.charCodeAt(0) - 1 : da;
    const cb = Number.isNaN(db) ? LAST.charCodeAt(0) + 1 : db;
    if (cb - ca > 1) {
      const mid = Math.floor((ca + cb) / 2);
      return prefix + String.fromCharCode(mid);
    }
    // Digits adjacent or equal: keep a's digit (or floor) and descend.
    prefix += String.fromCharCode(Number.isNaN(da) ? FIRST.charCodeAt(0) : da);
    i += 1;
  }
}

/**
 * A fresh evenly-spaced ascending sequence of `n` keys. Used by a coarse save,
 * which rewrites the whole body and so can relay the keys from scratch. Keys are
 * zero-padded to a fixed width so they stay byte-sortable as the count grows.
 */
export function sequence(n: number): string[] {
  if (n <= 0) return [];
  const width = Math.max(2, String(n + 1).length);
  const keys: string[] = [];
  for (let i = 1; i <= n; i++) {
    keys.push(String(i).padStart(width, "0"));
  }
  return keys;
}
