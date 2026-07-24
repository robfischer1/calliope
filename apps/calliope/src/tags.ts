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

/** scan.ts:62, verbatim — mirrored, not shared (render vs write halves). */
const TAG_RE = /(^|[^\w#[])#([A-Za-z][\w/-]*)/g;

/** A stored tag with its write provenance. */
export interface TagRow {
  tag: string;
  source: "inline" | "explicit";
}

/** Normalize one tag to its canonical stored form: `#lowercase`. */
export function normalizeTag(raw: string): string {
  const bare = raw.startsWith("#") ? raw.slice(1) : raw;
  return `#${bare.toLowerCase()}`;
}

/** Extract the inline `#tags` of a body text, normalized + deduped. */
export function extractInlineTags(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[2];
    if (tag !== undefined) {
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
      if (!have.has(tag)) {
        toAdd.push({ tag, source: "explicit" });
        have.set(tag, "explicit");
      }
    }
  }

  if (next.inline !== undefined) {
    const inline = new Set(next.inline.map(normalizeTag));
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
