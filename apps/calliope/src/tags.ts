/**
 * The tag path (C9) — extraction + reconcile, Calliope-authoritative.
 *
 * The grammar MIRRORS theia `packages/aglaia/src/decorations/scan.ts` (the
 * render side): `#` at word-start, a letter head, then letters/digits/_/-//.
 * Aglaia renders tags; Calliope is the ONE extractor that writes them —
 * scan.ts stays render-only (the master-plan's sole-authoritative decision).
 *
 * Tag identity is the lowercase-normalized literal (`#journal`) — the
 * `find_by_value` point lookup and the A21 `tag:` lens need one canonical
 * form. Tag-nodes (rename, metadata) are the later evolution, not this pass.
 */

/**
 * scan.ts:62, verbatim — mirrored, not shared (render vs write halves).
 *
 * A tag starts at text-start or after whitespace — never mid-word, and never
 * after any other punctuation. The prior grammar allowed any non-word
 * character ahead of `#`, which let a quoted Gmail permalink's URL fragment
 * (`.../u/0/#inbox/FMfcgzGrblhftmnGmMDXhFFlnVnRqHxL`) get swept in as a tag —
 * the `/` right before `#` qualified as a boundary. Rob's own inline
 * convention always has a space (or line-start) ahead of a `#tag`, so
 * tightening the boundary to whitespace-only is both the fix and the true
 * grammar; frontmatter's `tags:` field is a separate explicit source and
 * never runs through this regex at all.
 */
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
 * F11: a hex-color-shaped tag is junk on EVERY write path, not only at
 * inline extraction — the explicit path (`create_note` tags[]) and the
 * reconcile chokepoint call this on the normalized form. The measured
 * store carried nine Catppuccin palette literals (`#a6d189`…) written
 * before the extractor grew its guard; filtering the view would have left
 * them for the next consumer, so the rule lives at the data.
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

/** Extract the inline `#tags` of a body text, normalized + deduped. */
export function extractInlineTags(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TAG_RE)) {
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

/**
 * Compute the reconcile against the standing rows.
 *
 * - `explicit` (the create path): additive — new explicit tags land; nothing
 *   is ever removed by an explicit write (folder tags accumulate; removal is
 *   a deliberate later surface, not a side effect).
 * - `inline` (the body-write path): the inline set replaces the standing
 *   inline-sourced set; explicit-sourced rows are UNTOUCHABLE (deleting a
 *   paragraph must not strip `#journal`).
 * - A tag present as both keeps its standing provenance (explicit wins).
 */
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
      // F11: the chokepoint both paths flow through never admits junk.
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
