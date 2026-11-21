/** scan.ts:62, verbatim — mirrored, not shared (render vs write halves). */
const TAG_RE = /(^|\s)#([A-Za-z][\w/-]*)/g;

/**
 * CSS-style hex color shorthands (`#fff`, `#deadbeef`, `#cafe`, …) can pass
 * the tag grammar above whenever every character happens to be a hex digit
 * AND the body leads with a letter (a-f) — digit-led ones like `#4a90d9`
 * never reach here since the grammar already requires a letter head. Excluded
 * at the CSS-standard hex lengths: RGB / RGBA / RRGGBB / RRGGBBAA.
 */
const HEX_COLOR_LENGTHS = new Set([3, 4, 6, 8]);
const HEX_DIGITS_RE = /^[0-9a-f]+$/i;

function isHexColor(tag: string): boolean {
  return HEX_COLOR_LENGTHS.has(tag.length) && HEX_DIGITS_RE.test(tag);
}

/**
 * F11: a hex-color-shaped tag is junk on EVERY write path, not only at inline
 * extraction — the explicit path (`create_note` tags[]) and the reconcile
 * chokepoint call this on the normalized form.
 */
export function isJunkTag(normalized: string): boolean {
  const body = normalized.startsWith("#") ? normalized.slice(1) : normalized;
  return isHexColor(body);
}

/** A stored tag with its write provenance. */
export interface TagRow {
  tag: string;
  source: "inline" | "explicit";
}

/** Normalize one tag to its canonical stored form: `#lowercase`, with any
 *  trailing slashes stripped (F11 — `#brainsoup/` is a malformed capture of
 *  `#brainsoup`, a grammar fix; dash-insertion renames are tag-node
 *  territory and deliberately NOT guessed here). */
export function normalizeTag(raw: string): string {
  const bare = (raw.startsWith("#") ? raw.slice(1) : raw).replace(/\/+$/, "");
  return `#${bare.toLowerCase()}`;
}

/** A fence opener/closer: up to three spaces of indent, then a run of three
 *  or more backticks or tildes (CommonMark §4.5). */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Blank out the code in a body so the tag grammar never reads it — the rule
 * Obsidian applies: a `#word` inside a fenced block or an inline code span is
 * code, not a tag.
 */
export function maskCode(text: string): string {
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const marker = FENCE_RE.exec(line)?.[1];
      if (fence === undefined) {
        if (marker === undefined) return maskInlineCode(line);
        fence = marker;
        return "";
      }
      if (
        marker !== undefined &&
        marker.includes(fence) &&
        line.trim() === marker
      ) {
        fence = undefined;
      }
      return "";
    })
    .join("\n");
}

/** Blank every paired backtick span of one line (CommonMark §6.1): split on
 *  backtick runs (odd indices), pair each run with the next run of exactly
 *  the same width; an unpaired run stays literal. */
function maskInlineCode(line: string): string {
  const parts = line.split(/(`+)/);
  let closeAt = -1;
  return parts
    .map((part, k) => {
      if (k <= closeAt) return " ".repeat(part.length);
      if (k % 2 === 0) return part;
      closeAt = parts.findIndex((p, j) => j > k && p === part);
      return closeAt === -1 ? part : " ".repeat(part.length);
    })
    .join("");
}

/** Extract the inline `#tags` of a body text, normalized + deduped. Code is
 *  masked first — see `maskCode`. */
export function extractInlineTags(text: string): string[] {
  const out = new Set<string>();
  for (const m of maskCode(text).matchAll(TAG_RE)) {
    const tag = m[2];
    if (tag !== undefined && !isHexColor(tag)) {
      out.add(normalizeTag(tag));
    }
  }
  return [...out].sort();
}

/** The reconcile's computed delta. */
export interface TagDelta {
  /** Tags to write (edge + mirror row), with their provenance. */
  toAdd: TagRow[];
  /** Tags to retract (edge + mirror row) — inline-sourced only, ever. */
  toRemove: string[];
}

/** Compute the reconcile against the standing rows. */
export function computeTagDelta(
  standing: TagRow[],
  next: { inline?: string[]; explicit?: string[] },
): TagDelta {
  const have = new Map(standing.map((r) => [r.tag, r.source]));
  const toAdd: TagRow[] = [];
  const toRemove: string[] = [];

  if (next.explicit !== undefined) {
    for (const raw of next.explicit) {
      const tag = normalizeTag(raw);
      if (isJunkTag(tag)) continue;
      if (!have.has(tag)) {
        toAdd.push({ tag, source: "explicit" });
        have.set(tag, "explicit");
      }
    }
  }

  if (next.inline !== undefined) {
    const inline = new Set(
      next.inline.map(normalizeTag).filter((t) => !isJunkTag(t)),
    );
    for (const tag of inline) {
      if (!have.has(tag)) {
        toAdd.push({ tag, source: "inline" });
        have.set(tag, "inline");
      }
    }
    for (const [tag, source] of have) {
      if (source === "inline" && !inline.has(tag)) {
        toRemove.push(tag);
      }
    }
  }

  toAdd.sort((a, b) => a.tag.localeCompare(b.tag));
  toRemove.sort();
  return { toAdd, toRemove };
}
