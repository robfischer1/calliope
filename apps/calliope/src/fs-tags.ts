/**
 * The offline tag index (F12) — tags as a COMPUTED index over a served
 * directory, no graph anywhere near it. The phone and the offline desktop
 * browse by tag from this; `hasTag` edges materialise only at Dissolve
 * (the F9 verb), never here — the decided offline model.
 *
 * Computed per request, deliberately uncached: the watcher-invalidation
 * question dissolves when there is nothing to invalidate, and a local
 * directory's scan is cheap. The extraction grammar is the shared F11-guarded
 * `extractInlineTags` — hex junk and malformed captures never enter the
 * index, offline included.
 *
 * The fs GRAIN is untouched: this module never derives sections — it reads
 * file text for extraction only (index only, per the master-plan constraint).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { extractInlineTags, normalizeTag } from "./tags.js";
import type { TagCount } from "./tag-store.js";

/** Extensions the body layer serves — mirrored from fs-client (one seam). */
const SERVED_EXTENSIONS = new Set([".md", ".markdown"]);

/** The computed index: distinct tags with counts + tag → carrier node ids. */
export interface FsTagIndex {
  tags: TagCount[];
  byTag: Map<string, string[]>;
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // a vanished subdirectory mid-scan is not an error
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // .obsidian, .grace, .git …
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, abs, out);
    } else if (
      entry.isFile() &&
      SERVED_EXTENSIONS.has(path.extname(entry.name.toLowerCase()))
    ) {
      out.push(abs);
    }
  }
}

/**
 * Walk the served root and aggregate every file's inline tags. Node ids are
 * root-relative posix paths — the fs backend's node identity, verbatim.
 */
export async function computeFsTagIndex(root: string): Promise<FsTagIndex> {
  const absRoot = path.resolve(root);
  const files: string[] = [];
  await walk(absRoot, absRoot, files);

  const byTag = new Map<string, string[]>();
  for (const abs of files.sort()) {
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      continue; // vanished mid-scan
    }
    const nodeId = path.relative(absRoot, abs).split(path.sep).join("/");
    for (const tag of extractInlineTags(text)) {
      byTag.set(tag, [...(byTag.get(tag) ?? []), nodeId]);
    }
  }

  const tags: TagCount[] = [...byTag.entries()]
    .map(([tag, ids]) => ({ tag, count: ids.length }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
  return { tags, byTag };
}

/** `list_by_tag` over the computed index (tag normalized like the C9 verb). */
export async function fsListByTag(
  root: string,
  tag: string,
): Promise<{ tag: string; node_ids: string[] }> {
  const norm = normalizeTag(tag);
  const index = await computeFsTagIndex(root);
  return { tag: norm, node_ids: index.byTag.get(norm) ?? [] };
}

/** `list_tags` over the computed index. */
export async function fsListTags(root: string): Promise<{ tags: TagCount[] }> {
  const index = await computeFsTagIndex(root);
  return { tags: index.tags };
}
