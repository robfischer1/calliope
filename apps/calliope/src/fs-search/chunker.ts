/**
 * The index grain (Findability F2) — paragraph-shaped blocks over a served
 * directory. Deliberately NOT the body grain: the fs body facet derives one
 * section per file (the user grain); the search index chunks the same text
 * into blank-line paragraphs because that is the grain the corpus was
 * measured at (~92,800 blocks) and the grain snippets rank well at. Index
 * only — nothing here ever writes a body.
 *
 * Identity is the content hash: a changed paragraph is a NEW hash, an
 * unchanged one keeps its vector. That is what makes "one forward pass per
 * edited block" structural rather than aspirational.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Extensions the body layer serves — mirrored from fs-client (one seam). */
const SERVED_EXTENSIONS = new Set([".md", ".markdown"]);

/** One paragraph-shaped block, content-addressed. */
export interface Paragraph {
  ord: number;
  hash: string;
  text: string;
}

/** Normalize exactly as the body facet does: LF line endings. */
export function normalizeBody(raw: string): string {
  return raw.replace(/\r\n?/g, "\n");
}

/** Split a normalized body into paragraph blocks (blank-line grain). */
export function chunk(body: string): Paragraph[] {
  const out: Paragraph[] = [];
  let ord = 0;
  for (const piece of body.split(/\n{2,}/)) {
    const text = piece.trim();
    if (text === "") continue;
    out.push({
      ord,
      hash: createHash("sha256").update(text).digest("hex"),
      text,
    });
    ord++;
  }
  return out;
}

/** A wikilink's normalized target: the note name, lowercased, alias and
 *  heading/block refs stripped — `[[Notes/The Heron|the bird]]` and
 *  `[[the heron#Habits]]` both normalize to `the heron` (basename form,
 *  matching how links resolve against note names). */
export function extractWikilinks(text: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\][|#\n]+)(?:#[^\][|\n]*)?(?:\|[^\][\n]*)?\]\]/g;
  let match = re.exec(text);
  while (match !== null) {
    const raw = (match[1] ?? "").trim();
    if (raw !== "") {
      const base = raw.split("/").pop() ?? raw;
      out.push(base.toLowerCase().replace(/\.(md|markdown)$/, ""));
    }
    match = re.exec(text);
  }
  return out;
}

/** Is this root-relative posix path a served markdown body? */
export function isServedPath(relPath: string): boolean {
  if (relPath === "") return false;
  const segments = relPath.split("/");
  if (segments.some((s) => s.startsWith("."))) return false;
  return SERVED_EXTENSIONS.has(path.posix.extname(relPath.toLowerCase()));
}

/**
 * Walk the served root for markdown bodies, skipping dotted entries
 * (`.grace`, `.obsidian`, `.git`, …) — the index must never index itself.
 * Returns root-relative posix paths with (mtime, size) for the catch-up diff.
 */
export async function walkServed(
  root: string,
): Promise<{ path: string; mtime: number; size: number }[]> {
  const absRoot = path.resolve(root);
  const out: { path: string; mtime: number; size: number }[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // a vanished subdirectory mid-scan is not an error
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (
        entry.isFile() &&
        SERVED_EXTENSIONS.has(path.extname(entry.name.toLowerCase()))
      ) {
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          continue; // vanished between readdir and stat
        }
        const rel = path.relative(absRoot, abs).split(path.sep).join("/");
        out.push({
          path: rel,
          mtime: Math.trunc(stat.mtimeMs),
          size: stat.size,
        });
      }
    }
  }
  await walk(absRoot);
  return out;
}
