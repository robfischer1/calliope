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

/** A key strictly below `b`. */
function keyBelow(b: string): string {
  const head = b[0] ?? LAST;
  if (head > "0") {
    return String.fromCharCode(head.charCodeAt(0) - 1);
  }
  const tail = b.slice(1);
  if (tail === "" || /^0+$/.test(tail)) {
    if (b.length <= 1) {
      throw new Error(`between(): no key below the floor key "${b}"`);
    }
    return b.slice(0, -1);
  }
  return `0${keyBelow(tail)}`;
}

/** A key strictly above `a`. */
function keyAbove(a: string): string {
  if (a === "") return MID;
  const head = a[0] ?? FIRST;
  if (head < LAST) {
    return String.fromCharCode(head.charCodeAt(0) + 1);
  }
  return LAST + keyAbove(a.slice(1));
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

/** The longest key a write may mint before the container is re-laid. */
export const MAX_KEY_LEN = 4;

/**
 * `n` ascending keys strictly inside `(lo, hi)`, or `null` when they do not
 * fit under {@link MAX_KEY_LEN} (or no key exists at all, e.g. below the floor
 * key). `null` is the caller's cue to re-lay the whole container with
 * {@link sequence} in the same write.
 */
export function mintRun(
  lo: string | null,
  hi: string | null,
  n: number,
): string[] | null {
  const keys: string[] = [];
  let prev = lo;
  for (let i = 0; i < n; i++) {
    let key: string;
    try {
      key = between(prev, hi);
    } catch {
      return null;
    }
    if (key.length > MAX_KEY_LEN) return null;
    keys.push(key);
    prev = key;
  }
  return keys;
}
