/**
 * The .grace/ revlog (F13 — Rob's decision, 2026-08-10): local version
 * history for the fs backend, Calliope-owned, git-free — so the shipped
 * HistoryDrawer lights up offline in ANY directory, vault or not.
 *
 * Model: per-node JSONL snapshots at `.grace/revlog/<sha256(nodeId)>.jsonl`
 * — one `{revision, kind, text}` entry per observed state, full text (the
 * fs store's grain is one block per file; deltas would buy nothing).
 * Entries are head-deduped (rewriting the same content appends nothing),
 * timestamps are strictly increasing per node, and the count caps at
 * {@link MAX_ENTRIES} with the oldest dropped — bounded by construction.
 *
 * Deleting `.grace/` is always safe: it loses HISTORY only, never bodies,
 * and the next write restarts the log. The dot-directory is invisible to
 * the body layer (non-markdown paths refuse) and to the F12 tag walker
 * (dot-directories skip).
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

/** One recorded state of a node's body. */
export interface RevlogEntry {
  /** ISO-8601 UTC stamp — the revision identity (strictly increasing). */
  revision: string;
  kind: "save" | "edit";
  /** The full normalized body text at this state. */
  text: string;
}

/** The per-node entry cap — the growth bound. */
export const MAX_ENTRIES = 200;

export class FsRevlog {
  readonly #dir: string;

  constructor(root: string) {
    this.#dir = path.join(path.resolve(root), ".grace", "revlog");
  }

  #fileFor(nodeId: string): string {
    const name = createHash("sha256").update(nodeId, "utf8").digest("hex");
    return path.join(this.#dir, `${name}.jsonl`);
  }

  /** All entries for a node, oldest first ([] when absent or unreadable). */
  async entries(nodeId: string): Promise<RevlogEntry[]> {
    try {
      const raw = await fs.readFile(this.#fileFor(nodeId), "utf8");
      const out: RevlogEntry[] = [];
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const parsed = JSON.parse(line) as RevlogEntry;
          if (
            typeof parsed.revision === "string" &&
            typeof parsed.text === "string"
          ) {
            out.push(parsed);
          }
        } catch {
          // a torn line loses one entry, never the log
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Append one observed state — head-deduped, monotonic, capped. Returns
   * the appended entry, or `null` when the head already carries `text`.
   */
  async append(
    nodeId: string,
    kind: RevlogEntry["kind"],
    text: string,
  ): Promise<RevlogEntry | null> {
    const existing = await this.entries(nodeId);
    const head = existing.at(-1);
    if (head?.text === text) {
      return null;
    }
    let stamp = Date.now();
    if (head !== undefined) {
      const headMs = Date.parse(head.revision);
      if (Number.isFinite(headMs) && stamp <= headMs) {
        stamp = headMs + 1;
      }
    }
    const entry: RevlogEntry = {
      revision: new Date(stamp).toISOString(),
      kind,
      text,
    };
    const next = [...existing, entry].slice(-MAX_ENTRIES);
    await fs.mkdir(this.#dir, { recursive: true });
    const file = this.#fileFor(nodeId);
    const tmp = `${file}.tmp-${process.pid.toString(36)}`;
    await fs.writeFile(
      tmp,
      `${next.map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf8",
    );
    await fs.rename(tmp, file);
    return entry;
  }
}
