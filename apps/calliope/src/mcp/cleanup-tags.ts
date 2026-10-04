#!/usr/bin/env bun
/**
 * F11 cleanup tool — sweep the persisted tag junk from the STORE, not the
 * render. Junk (hex-color-shaped) tags lose their mirror rows AND their
 * carrier `hasTag` edges on the graph; malformed trailing-slash variants
 * merge into their normalized form (edge re-pointed, row rewritten).
 *
 * Modes (env: `DATABASE_URL`, `CALLIOPE_CHAOS_URL`, `CALLIOPE_THEMIS_URL`):
 *
 *   bun run src/mcp/cleanup-tags.ts            # apply (idempotent)
 *   bun run src/mcp/cleanup-tags.ts --probe    # read-only plan
 *   bun run src/mcp/cleanup-tags.ts --archived [--probe]
 *       sweep the INLINE tags off every isArchived note (the phdb-migration
 *       corpus — C source, spreadsheets, mail — whose bodies the reconcile
 *       tagged before it learned to skip them); explicit rows stay.
 *   bun run src/mcp/cleanup-tags.ts --heal <tag>... [--probe]
 *       drop the mirror rows for those tags whose carrier no longer holds
 *       the `hasTag` edge on the graph — the follow-up to a retraction made
 *       through the graph verbs, which never touch this mirror. The graph is
 *       the truth; this only ever deletes rows, never edges.
 *
 * Reversibility: chaos is append-only — the retractions are logged ops on
 * the substrate, so the sweep is reversible at the substrate level; no undo
 * verb ships. The sweep covers what the mirror enumerates (the mirror is
 * `list_tags`' source); a graph edge with no mirror row is invisible to
 * enumeration and heals on its note's next reconcile.
 */

import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { isJunkTag, normalizeTag } from "../tags.js";
import type { TagCount, TagStore } from "../tag-store.js";
import {
  LiveChaosDial,
  notesScope,
  opAdd,
  opRemove,
  type ChaosDial,
  type ChaosOp,
} from "../chaos-client.js";
import { PgTagStore } from "../tag-store.js";
import { HAS_TAG, sweepArchivedTags } from "./tools.js";

/** The pure plan: which stored tags are removed, which merge to what. */
export interface TagCleanupPlan {
  remove: string[];
  merge: [from: string, to: string][];
}

/** Compute the cleanup from the distinct enumeration — pure, unit-tested. */
export function planTagCleanup(distinct: readonly TagCount[]): TagCleanupPlan {
  const remove: string[] = [];
  const merge: [string, string][] = [];
  for (const { tag } of distinct) {
    const canonical = normalizeTag(tag);
    if (isJunkTag(canonical)) {
      remove.push(tag);
    } else if (canonical !== tag) {
      merge.push([tag, canonical]);
    }
  }
  return { remove, merge };
}

/** One mirror row whose carrier no longer holds the graph edge. */
export interface MirrorOrphan {
  node_id: string;
  tag: string;
}

/** What a mirror heal found (and, unless probing, removed). */
export interface MirrorHeal {
  /** Mirror rows checked against the graph. */
  checked: number;
  /** Rows with no matching `hasTag` edge on their carrier. */
  orphans: MirrorOrphan[];
}

/**
 * Re-align the mirror to the graph for the given tags: a row survives only
 * while its carrier still holds `hasTag = tag` as a literal edge. The mirror
 * is `list_tags`' source, so an edge retracted through the graph verbs keeps
 * its chip until this runs (or the note next reconciles).
 */
export async function healMirror(
  dial: ChaosDial,
  store: TagStore,
  tags: readonly string[],
  probe: boolean,
): Promise<MirrorHeal> {
  const orphans: MirrorOrphan[] = [];
  let checked = 0;
  for (const tag of tags.map(normalizeTag)) {
    for (const nodeId of await store.carriers(tag)) {
      checked += 1;
      const edges = await dial.edges(nodeId);
      const held = edges.some(
        (e) => e.predicate === HAS_TAG && e.value === tag,
      );
      if (held) continue;
      orphans.push({ node_id: nodeId, tag });
      if (!probe) await store.remove(nodeId, tag);
    }
  }
  return { checked, orphans };
}

/** The tags named after `--heal`, up to the next flag. */
export function healTags(argv: readonly string[]): string[] {
  const at = argv.indexOf("--heal");
  if (at === -1) return [];
  const rest = argv.slice(at + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end === -1 ? rest : rest.slice(0, end);
}

/** The seams `main` reaches for when not handed them — the live store and
 *  door in production, fixtures under test. */
export interface CleanupDeps {
  dial?: ChaosDial;
  store?: TagStore;
  write?: (line: string) => void;
}

export async function main(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  deps: CleanupDeps = {},
): Promise<void> {
  const probe = argv.includes("--probe");
  const dbUrl = env.DATABASE_URL;
  if (dbUrl === undefined || dbUrl === "") {
    throw new Error("DATABASE_URL is required.");
  }
  const pool = new Pool({ connectionString: dbUrl });
  const write = deps.write ?? ((line: string) => process.stdout.write(line));
  try {
    if (argv.includes("--archived")) {
      const report = await sweepArchivedTags(
        deps.dial ?? new LiveChaosDial(),
        notesScope(env),
        deps.store ?? new PgTagStore(pool),
        probe,
      );
      write(`${JSON.stringify({ probe, ...report })}\n`);
      return;
    }
    if (argv.includes("--heal")) {
      const report = await healMirror(
        deps.dial ?? new LiveChaosDial(),
        deps.store ?? new PgTagStore(pool),
        healTags(argv),
        probe,
      );
      write(`${JSON.stringify({ probe, ...report })}\n`);
      return;
    }
    const distinct = await pool.query<{ tag: string; count: string }>(
      "SELECT tag, COUNT(*)::text AS count FROM note_tags GROUP BY tag ORDER BY tag",
    );
    const plan = planTagCleanup(
      distinct.rows.map((r) => ({ tag: r.tag, count: Number(r.count) })),
    );
    if (probe) {
      process.stdout.write(`${JSON.stringify(plan)}\n`);
      return;
    }

    const dial: ChaosDial = new LiveChaosDial();
    const scope = notesScope(process.env);
    let edgesRetracted = 0;
    let rowsDeleted = 0;

    const carriersOf = async (tag: string): Promise<string[]> => {
      const res = await pool.query<{ node_id: string }>(
        "SELECT node_id FROM note_tags WHERE tag = $1",
        [tag],
      );
      return res.rows.map((r) => r.node_id);
    };

    for (const tag of plan.remove) {
      const carriers = await carriersOf(tag);
      const ops: ChaosOp[] = carriers.map((n) =>
        opRemove(n, "hasTag", { toLiteral: tag }),
      );
      if (ops.length > 0) {
        const res = await dial.admit(ops, scope);
        if (!res.admitted) {
          throw new Error(
            `cleanup-tags: the gate refused the retraction batch for ${tag}: ` +
              JSON.stringify(res.violations),
          );
        }
        edgesRetracted += ops.length;
      }
      const del = await pool.query("DELETE FROM note_tags WHERE tag = $1", [
        tag,
      ]);
      rowsDeleted += del.rowCount ?? 0;
    }

    for (const [from, to] of plan.merge) {
      const carriers = await carriersOf(from);
      const ops: ChaosOp[] = carriers.flatMap((n) => [
        opRemove(n, "hasTag", { toLiteral: from }),
        opAdd(n, "hasTag", { toLiteral: to }),
      ]);
      if (ops.length > 0) {
        const res = await dial.admit(ops, scope);
        if (!res.admitted) {
          throw new Error(
            `cleanup-tags: the gate refused the merge batch for ${from}: ` +
              JSON.stringify(res.violations),
          );
        }
        edgesRetracted += carriers.length;
      }
      for (const n of carriers) {
        await pool.query(
          `INSERT INTO note_tags (node_id, tag, source)
           SELECT node_id, $3, source FROM note_tags
            WHERE node_id = $1 AND tag = $2
           ON CONFLICT (node_id, tag) DO NOTHING`,
          [n, from, to],
        );
        const del = await pool.query(
          "DELETE FROM note_tags WHERE node_id = $1 AND tag = $2",
          [n, from],
        );
        rowsDeleted += del.rowCount ?? 0;
      }
    }

    process.stdout.write(
      `${JSON.stringify({
        removed_tags: plan.remove.length,
        merged_tags: plan.merge.length,
        edges_retracted: edgesRetracted,
        rows_deleted: rowsDeleted,
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `cleanup-tags: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
