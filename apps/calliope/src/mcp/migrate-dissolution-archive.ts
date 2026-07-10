#!/usr/bin/env node
/**
 * C5 archival tool — copy the RETIRED dissolution-bridge's registries
 * (`history.dissolutions`, `history.file_revision_dissolutions`,
 * `history.materialization_events`) into Calliope as frozen historical
 * record (specs/005: the bridge's bookkeeping survives the machinery's
 * death). Row-count parity is the gate (the tables are id-preserved,
 * verbatim copies — `archive_*` prefixed).
 *
 *   bun run src/mcp/migrate-dissolution-archive.ts           # copy + parity + export
 *   bun run src/mcp/migrate-dissolution-archive.ts --probe   # counts only
 *
 * Env: PHDB_DATABASE_URL (source), DATABASE_URL (calliope-db), EXPORT_PATH.
 */

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

const EXPORT_PATH =
  process.env.EXPORT_PATH ?? "/tmp/calliope-dissolution-archive-export.json";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS archive_dissolutions (
  id bigint PRIMARY KEY, plan_slug text, plan_pk bigint, migration_id text,
  commit_sha text, wave_label text, dissolved_at timestamptz,
  schema_type text, repo text, target_schemas text, target_tables text,
  rationale text, declared_at text, declared_by text, dissolved_paths text
);
CREATE TABLE IF NOT EXISTS archive_file_revision_dissolutions (
  id bigint PRIMARY KEY, file_revision_id bigint, dissolution_id bigint
);
CREATE TABLE IF NOT EXISTS archive_materialization_events (
  id bigint PRIMARY KEY, vault_path text, source_table text, source_id bigint,
  materialized_at timestamptz, repo text, source_dissolution_pk bigint,
  materializer text, materialization_kind text
);
`;

interface TableSpec {
  source: string;
  dest: string;
  columns: string[];
}

const TABLES: TableSpec[] = [
  {
    source: "history.dissolutions",
    dest: "archive_dissolutions",
    columns: [
      "id",
      "plan_slug",
      "plan_pk",
      "migration_id",
      "commit_sha",
      "wave_label",
      "dissolved_at",
      "schema_type",
      "repo",
      "target_schemas",
      "target_tables",
      "rationale",
      "declared_at",
      "declared_by",
      "dissolved_paths",
    ],
  },
  {
    source: "history.file_revision_dissolutions",
    dest: "archive_file_revision_dissolutions",
    columns: ["id", "file_revision_id", "dissolution_id"],
  },
  {
    source: "history.materialization_events",
    dest: "archive_materialization_events",
    columns: [
      "id",
      "vault_path",
      "source_table",
      "source_id",
      "materialized_at",
      "repo",
      "source_dissolution_pk",
      "materializer",
      "materialization_kind",
    ],
  },
];

async function run(probe: boolean): Promise<void> {
  const phdbUrl = process.env.PHDB_DATABASE_URL;
  const calliopeUrl = process.env.DATABASE_URL;
  if (phdbUrl === undefined || phdbUrl === "") {
    throw new Error("PHDB_DATABASE_URL is required (the archive source).");
  }
  if (calliopeUrl === undefined || calliopeUrl === "") {
    throw new Error("DATABASE_URL is required (the calliope-db destination).");
  }
  const phdb = new Pool({ connectionString: phdbUrl, max: 2 });
  const calliope = new Pool({ connectionString: calliopeUrl, max: 2 });
  await calliope.query(SCHEMA_SQL);

  const results: Record<
    string,
    { source: number; dest: number; copied: number }
  > = {};
  let mismatches = 0;

  for (const t of TABLES) {
    let copied = 0;
    if (!probe) {
      const rows = await phdb.query<Record<string, unknown>>(
        `SELECT ${t.columns.join(", ")} FROM ${t.source} ORDER BY id`,
      );
      for (const row of rows.rows) {
        const placeholders = t.columns
          .map((_, i) => `$${String(i + 1)}`)
          .join(", ");
        await calliope.query(
          `INSERT INTO ${t.dest} (${t.columns.join(", ")})
           VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
          t.columns.map((c) => row[c]),
        );
        copied += 1;
      }
    }
    const src = await phdb.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ${t.source}`,
    );
    const dst = await calliope.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ${t.dest}`,
    );
    const srcN = Number(src.rows[0]?.n ?? 0);
    const dstN = Number(dst.rows[0]?.n ?? 0);
    results[t.dest] = { source: srcN, dest: dstN, copied };
    if (srcN !== dstN) mismatches += 1;
  }

  const artifact = {
    ran_at: new Date().toISOString(),
    mode: probe ? "probe" : "archive",
    tables: results,
    count_mismatches: mismatches,
  };
  writeFileSync(EXPORT_PATH, JSON.stringify(artifact, null, 2));
  process.stderr.write(
    `migrate-dissolution-archive: ${JSON.stringify(results)} mismatches=${String(mismatches)} artifact=${EXPORT_PATH}\n`,
  );

  await phdb.end();
  await calliope.end();
  if (mismatches > 0) process.exitCode = 1;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  run(process.argv.includes("--probe")).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`migrate-dissolution-archive: FATAL: ${message}\n`);
    process.exitCode = 1;
  });
}

export { run as runDissolutionArchive };
