#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { PgDocumentStore } from "../document-store.js";

const EXPORT_PATH =
  process.env.EXPORT_PATH ?? "/tmp/calliope-documents-export.json";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A source row joined with its resolved source path. */
interface SourceRow {
  id: string | number;
  schema_type: string | null;
  title: string | null;
  body_text: string | null;
  content_hash: string | null;
  raw_hash: string | null;
  created_at: Date | null;
  metadata_json: Record<string, unknown> | null;
  source_path: string | null;
}

async function readSourceRows(phdb: Pool): Promise<SourceRow[]> {
  const res = await phdb.query<SourceRow>(
    `SELECT d.id, d.schema_type, d.title, d.body_text, d.content_hash,
            d.raw_hash, d.created_at, d.metadata_json, sf.source_path AS source_path
       FROM history.documents d
       LEFT JOIN _infra.source_files sf ON sf.id = d.source_file_id
      ORDER BY d.id`,
  );
  return res.rows;
}

interface RunStats {
  source_rows: number;
  migrated: number;
  deduped: number;
  pathless: number;
  parity_checked: number;
  mismatches: { source_id: number; reason: string }[];
}

async function run(probe: boolean): Promise<void> {
  const phdbUrl = process.env.PHDB_DATABASE_URL;
  const calliopeUrl = process.env.DATABASE_URL;
  if (phdbUrl === undefined || phdbUrl === "") {
    throw new Error("PHDB_DATABASE_URL is required (the migration source).");
  }
  if (calliopeUrl === undefined || calliopeUrl === "") {
    throw new Error("DATABASE_URL is required (the calliope-db destination).");
  }
  const phdb = new Pool({ connectionString: phdbUrl });
  const calliope = new Pool({ connectionString: calliopeUrl });
  const store = new PgDocumentStore(calliope);
  await store.ensureSchema();

  const rows = await readSourceRows(phdb);
  const stats: RunStats = {
    source_rows: rows.length,
    migrated: 0,
    deduped: 0,
    pathless: 0,
    parity_checked: 0,
    mismatches: [],
  };

  for (const row of rows) {
    const body = row.body_text ?? "";
    const meta = row.metadata_json ?? {};
    const sourcePath =
      row.source_path ??
      (typeof meta.source_path === "string" ? meta.source_path : null) ??
      `phdb-document:${String(row.id)}`;
    if (row.source_path === null) stats.pathless += 1;

    if (!probe) {
      const result = await store.write({
        source_path: sourcePath,
        body_text: body,
        schema_type: row.schema_type ?? "DigitalDocument",
        ...(row.title !== null ? { subject: row.title } : {}),
        ...(typeof meta.file_path === "string"
          ? { file_path: meta.file_path }
          : {}),
        ...(typeof meta.mtime === "string" ? { mtime: meta.mtime } : {}),
        ...(typeof meta.ctime === "string" ? { ctime: meta.ctime } : {}),
        source_kind: "phdb-migration",
        raw_hash: row.raw_hash ?? sha256(body),
      });
      if (result.deduped) stats.deduped += 1;
      else stats.migrated += 1;
    }

    const destRows = await store.bySourcePath(sourcePath);
    const wantHash = sha256(body);
    const match = destRows.find((d) => d.content_hash === wantHash);
    stats.parity_checked += 1;
    if (match === undefined) {
      stats.mismatches.push({
        source_id: Number(row.id),
        reason: probe
          ? "no destination row with matching body hash (probe mode)"
          : "written but read-back hash mismatch",
      });
    }
  }

  const artifact = {
    ran_at: new Date().toISOString(),
    mode: probe ? "probe" : "migrate",
    ...stats,
  };
  writeFileSync(EXPORT_PATH, JSON.stringify(artifact, null, 2));

  process.stderr.write(
    `migrate-documents: source=${String(stats.source_rows)} ` +
      `migrated=${String(stats.migrated)} deduped=${String(stats.deduped)} ` +
      `pathless=${String(stats.pathless)} ` +
      `mismatches=${String(stats.mismatches.length)} ` +
      `artifact=${EXPORT_PATH}\n`,
  );

  await phdb.end();
  await calliope.end();

  if (stats.mismatches.length > 0) {
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  run(process.argv.includes("--probe")).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`migrate-documents: FATAL: ${message}\n`);
    process.exitCode = 1;
  });
}

export { run as runDocumentMigration };
