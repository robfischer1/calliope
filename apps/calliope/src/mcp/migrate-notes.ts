#!/usr/bin/env bun
/**
 * F6 migration tool — consolidate the documents store into notes.
 *
 * Every distinct `source_path` becomes ONE note (graph identity named by the
 * path, provenance as attributes) whose body is a one-block container; the
 * path's stored versions land as copy-on-write generations in stored order
 * (oldest first), so as-of reconstruction serves each version. The table
 * itself is untouched — reads stay on it until F7 cuts over and drops it.
 *
 * Modes (run from a checkout with reachability to calliope-db AND the graph
 * plane — `DATABASE_URL`, `CALLIOPE_CHAOS_URL`, `CALLIOPE_THEMIS_URL`):
 *
 *   bun run src/mcp/migrate-notes.ts            # migrate + parity (idempotent)
 *   bun run src/mcp/migrate-notes.ts --probe    # read-only counts
 *
 * The parity gate: after sinking a path, the note's active body must be
 * byte-identical to the path's newest stored version. Any mismatch exits
 * nonzero naming the path. A re-run of a converged store performs zero new
 * writes (the sink no-ops at every layer) — run it twice, prove the second
 * pass is silent.
 */

import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type { BodyClient } from "../types.js";
import type { DocumentStore } from "../document-store.js";
import { PgDocumentStore } from "../document-store.js";
import { PgBodyClient } from "../pg-client.js";
import { PgTagStore, type TagStore } from "../tag-store.js";
import { LiveChaosDial, notesScope, type ChaosDial } from "../chaos-client.js";
import { sinkNoteVersion } from "../notes-sink.js";

/** One migration run's outcome — the numbers the report pastes. */
export interface MigrateNotesReport {
  paths: number;
  versions: number;
  minted: number;
  superseded: number;
  nooped: number;
  parity_mismatches: string[];
}

/**
 * Migrate every stored document into its note. Pure function of the seams —
 * unit-tested over the fixtures exactly as production drives it live.
 */
export async function migrateNotes(
  store: DocumentStore,
  client: BodyClient,
  dial: ChaosDial,
  scope: string,
  tagStore?: TagStore,
): Promise<MigrateNotesReport> {
  const paths = await store.listSourcePaths();
  const report: MigrateNotesReport = {
    paths: paths.length,
    versions: 0,
    minted: 0,
    superseded: 0,
    nooped: 0,
    parity_mismatches: [],
  };

  for (const sourcePath of paths) {
    // bySourcePath answers newest-first; versions land oldest-first so the
    // newest ends as the active generation.
    const versions = [...(await store.bySourcePath(sourcePath))].reverse();

    // Convergence check — a naive replay would THRASH a converged store
    // (re-sinking v1 supersedes the active v2, then v2 supersedes v1 again:
    // two junk generations per run). A path is converged iff the note
    // exists, its active body is byte-identical to the newest version, and
    // it carries at least one generation per stored version. The check is
    // exact because (source_path, raw_hash) is UNIQUE — one path can never
    // hold two identical bodies, so a full replay writes exactly one
    // generation per version.
    const newestRow = versions.at(-1);
    const [standing] = await dial.findByName("Note", sourcePath);
    if (standing !== undefined && newestRow !== undefined) {
      const activeBody = await client.readBody(standing);
      const activeText = activeBody.map((s) => s.text).join("\n");
      const events =
        client.readRevisions === undefined
          ? []
          : await client.readRevisions(standing, versions.length + 1);
      if (
        activeBody.length === 1 &&
        activeText === newestRow.body_text &&
        events.length >= versions.length
      ) {
        report.versions += versions.length;
        report.nooped += versions.length;
        continue;
      }
    }

    let nodeId: string | null = null;
    for (const row of versions) {
      const result = await sinkNoteVersion(
        client,
        dial,
        scope,
        tagStore,
        {
          source_path: row.source_path,
          body_text: row.body_text,
          schema_type: row.schema_type,
          ...(row.title !== null ? { subject: row.title } : {}),
          ...(row.file_path !== null ? { file_path: row.file_path } : {}),
          ...(row.mtime !== null ? { mtime: row.mtime } : {}),
          ...(row.ctime !== null ? { ctime: row.ctime } : {}),
          source_kind: row.source_kind,
          raw_hash: row.raw_hash,
        },
        row.created_at,
      );
      nodeId = result.node_id;
      report.versions += 1;
      report[result.generation] += 1;
    }

    // The parity gate: active body === newest stored version, byte-for-byte.
    const newest = versions.at(-1);
    if (nodeId !== null && newest !== undefined) {
      const body = await client.readBody(nodeId);
      const active = body.map((s) => s.text).join("\n");
      if (body.length !== 1 || active !== newest.body_text) {
        report.parity_mismatches.push(sourcePath);
      }
    }
  }
  return report;
}

async function main(): Promise<void> {
  const probe = process.argv.includes("--probe");
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl === undefined || dbUrl === "") {
    throw new Error("DATABASE_URL is required.");
  }
  const pool = new Pool({ connectionString: dbUrl });
  const store = new PgDocumentStore(pool);
  try {
    if (probe) {
      const paths = await store.listSourcePaths();
      const rows = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM documents",
      );
      process.stdout.write(
        `${JSON.stringify({ rows: rows.rows[0]?.n ?? 0, paths: paths.length })}\n`,
      );
      return;
    }
    const client = new PgBodyClient(pool);
    await client.ensureSchema();
    const dial = new LiveChaosDial();
    const tags = new PgTagStore(pool);
    await tags.ensureSchema();
    const report = await migrateNotes(
      store,
      client,
      dial,
      notesScope(process.env),
      tags,
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.parity_mismatches.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `migrate-notes: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
