#!/usr/bin/env node
/**
 * Backfill urania's similarity index with EXISTING body prose (B).
 *
 * The write-side push ({@link IndexingBodyClient}) only fires on NEW writes, so
 * bodies that already exist when the push ships stay invisible to
 * suggest_parent / search until they are re-written. This one-off sweep closes
 * that gap: it enumerates every body-bearing node in calliope's sovereign
 * store, reads each body, and pushes the assembled prose to urania's
 * `index_document` verb.
 *
 * Run where BOTH the sovereign store and urania are reachable (the deployed
 * container, or a one-off docker run on nas01):
 *
 *   bun run src/mcp/backfill-index.ts           # push every body (idempotent)
 *   bun run src/mcp/backfill-index.ts --probe   # count body-bearing nodes only
 *
 * Env:
 *   DATABASE_URL          calliope-db (the sovereign body store; read)
 *   CALLIOPE_INDEX_URL    urania's MCP endpoint (else URANIA_URL / CHAOS_URL)
 *
 * Idempotent: a re-run re-pushes the same prose and urania's `set_body` upserts,
 * so a repeat is a no-op change. A per-node push failure is tallied and the
 * sweep continues — the projection self-heals on the next write or a re-run.
 */

import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type { Section } from "../types.js";
import { PgBodyClient } from "../pg-client.js";
import { UraniaIndexClient, type IndexPusher } from "./index-push.js";

/** The reads the sweep needs — satisfied by {@link PgBodyClient} or a double. */
export interface BackfillSource {
  listBodyNodeIds(): Promise<string[]>;
  readBody(nodeId: string): Promise<Section[]>;
}

/** Sweep outcome: how many nodes were seen, pushed, and failed. */
export interface BackfillResult {
  nodes: number;
  pushed: number;
  failed: number;
}

/**
 * Push every body-bearing node's assembled prose to urania's index. In `probe`
 * mode it only counts. A per-node failure is tallied and the sweep continues,
 * so one unreachable node never aborts the backfill.
 */
export async function backfillIndex(
  source: BackfillSource,
  index: IndexPusher,
  opts: { probe?: boolean } = {},
): Promise<BackfillResult> {
  const nodeIds = await source.listBodyNodeIds();
  if (opts.probe === true) {
    return { nodes: nodeIds.length, pushed: 0, failed: 0 };
  }
  let pushed = 0;
  let failed = 0;
  for (const nodeId of nodeIds) {
    try {
      const sections = await source.readBody(nodeId);
      const body = sections.map((s) => s.text).join("\n\n");
      await index.indexDocument(nodeId, body);
      pushed += 1;
    } catch {
      failed += 1;
    }
  }
  return { nodes: nodeIds.length, pushed, failed };
}

/** The urania endpoint (mirrors backend.ts' resolution order). */
function indexUrl(env: NodeJS.ProcessEnv): string | undefined {
  const url = env.CALLIOPE_INDEX_URL ?? env.URANIA_URL ?? env.CHAOS_URL;
  return url !== undefined && url !== "" ? url : undefined;
}

async function main(): Promise<void> {
  const probe = process.argv.includes("--probe");
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl === undefined || dbUrl === "") {
    throw new Error(
      "backfill-index: DATABASE_URL (the sovereign store) is required.",
    );
  }
  const url = indexUrl(process.env);
  if (!probe && url === undefined) {
    throw new Error(
      "backfill-index: no urania endpoint (set CALLIOPE_INDEX_URL / " +
        "URANIA_URL / CHAOS_URL).",
    );
  }
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const source = new PgBodyClient(pool);
    const index: IndexPusher =
      url === undefined
        ? { indexDocument: () => Promise.resolve() }
        : new UraniaIndexClient(url);
    const result = await backfillIndex(source, index, { probe });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exitCode = 1;
  });
}
