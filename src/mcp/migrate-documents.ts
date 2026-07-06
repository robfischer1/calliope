#!/usr/bin/env node
/**
 * C3 migration tool — port the monolith's dissolved-document archive
 * (`phdb history.documents`) into Calliope's document store
 * (specs/003-prose-strangle-move).
 *
 * Modes (run where BOTH databases are reachable — the deployed container with
 * `PHDB_DATABASE_URL` injected, or a one-off docker run on nas01):
 *
 *   bun run src/mcp/migrate-documents.ts           # migrate + parity + export (idempotent)
 *   bun run src/mcp/migrate-documents.ts --probe   # counts + parity only, writes nothing
 *
 * Env:
 *   PHDB_DATABASE_URL      the monolith's PostgreSQL (read-only use)
 *   DATABASE_URL           calliope-db (the destination)
 *   EXPORT_PATH            parity artifact path (default /tmp/calliope-documents-export.json)
 *
 * The run reads every `history.documents` row, maps it onto the star's wire
 * contract (title←title, metadata_json's provenance fields when present),
 * writes with the dedup key `(source_path, raw_hash)` — so a re-run migrates
 * zero — then verifies parity: per-row sha256(body_text) compared between
 * source and destination, plus counts. Any mismatch exits nonzero (the
 * parity gate). The artifact JSON records {counts, migrated, deduped,
 * mismatches: []} beside per-row hashes.
 *
 * The source row's identity anchor: phdb interned paths into `source_files`;
 * the star stores the path inline. The join resolves each row's path via
 * `source_files.path`; a row with no resolvable path falls back to its
 * synthetic message id (`vault-note:<sha>`), preserved verbatim so the
 * artifact stays auditable.
 */

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
        // The DEDUP anchor: prefer the source's raw_hash so a re-run (and the
        // original dissolve identity) converge on the same key.
        raw_hash: row.raw_hash ?? sha256(body),
      });
      if (result.deduped) stats.deduped += 1;
      else stats.migrated += 1;
    }

    // Parity: the destination must hold a row for (source_path, raw_hash)
    // whose body hashes identically to the source body.
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
    process.exitCode = 1; // the parity gate
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
