#!/usr/bin/env node
/**
 * C4 migration tool — port the git-for-ideas archive (`phdb
 * history.file_revisions` + `history.revision_triple_deltas`) into
 * Calliope's revision store (specs/004-notes-and-revision).
 *
 * Modes (run where BOTH databases are reachable — the deployed container
 * with `PHDB_DATABASE_URL` injected; the C3 harness):
 *
 *   bun run src/mcp/migrate-revisions.ts           # migrate + parity + export
 *   bun run src/mcp/migrate-revisions.ts --probe   # counts + parity only
 *
 * Ids are preserved verbatim (the deltas key on revision id; re-runs are
 * idempotent via ON CONFLICT DO NOTHING). Deltas are DENORMALIZED at copy:
 * the monolith stores (subject, predicate, object) as pks into a 13M-row
 * node dictionary — the source query joins them to labels so the star's
 * archive is self-contained.
 *
 * Parity: counts both tables, then a second pass streams BOTH sides in id
 * order (keyset pages) comparing per-row sha256 over a canonical field
 * list. Any mismatch exits nonzero. The artifact JSON records everything.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { PgRevisionStore } from "../revision-store.js";

const EXPORT_PATH =
  process.env.EXPORT_PATH ?? "/tmp/calliope-revisions-export.json";
const PAGE = 1000;

function hashRow(fields: (string | number | null)[]): string {
  return createHash("sha256")
    .update(JSON.stringify(fields), "utf8")
    .digest("hex");
}

const REV_SELECT = `
  SELECT id, schema_type, repo, commit_sha, file_path, prior_file_path,
         change_type, authorship, summary, summary_model,
         summary_generated_at::text AS summary_generated_at,
         git_blob_sha, parent_blob_sha, captured_at
    FROM history.file_revisions`;

const DELTA_SELECT = `
  SELECT d.id, d.revision_pk AS revision_id, d.op,
         sn.label  AS subject,
         p.name    AS predicate,
         obj.label AS object
    FROM history.revision_triple_deltas d
    LEFT JOIN triples.nodes      sn  ON sn.id  = d.subject_node_pk
    LEFT JOIN triples.predicates p   ON p.id   = d.predicate_pk
    LEFT JOIN triples.nodes      obj ON obj.id = d.object_node_pk`;

interface SourceRevision {
  id: string | number;
  schema_type: string | null;
  repo: string | null;
  commit_sha: string | null;
  file_path: string;
  prior_file_path: string | null;
  change_type: string | null;
  authorship: string | null;
  summary: string | null;
  summary_model: string | null;
  summary_generated_at: string | null;
  git_blob_sha: string | null;
  parent_blob_sha: string | null;
  captured_at: Date | null;
}

interface SourceDelta {
  id: string | number;
  revision_id: string | number;
  op: string | null;
  subject: string | null;
  predicate: string | null;
  object: string | null;
}

function revisionHashFields(r: {
  file_path: string;
  commit_sha: string | null;
  git_blob_sha: string | null;
  summary: string | null;
  change_type: string | null;
}): (string | null)[] {
  return [r.file_path, r.commit_sha, r.git_blob_sha, r.summary, r.change_type];
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
  const phdb = new Pool({ connectionString: phdbUrl, max: 4 });
  const calliope = new Pool({ connectionString: calliopeUrl, max: 4 });
  const store = new PgRevisionStore(calliope);
  await store.ensureSchema();

  const stats = {
    source_revisions: 0,
    source_deltas: 0,
    migrated_revisions: 0,
    migrated_deltas: 0,
    parity_mismatches: [] as { table: string; id: number; reason: string }[],
  };

  // ── Pass 1: copy (skipped in probe mode) ──────────────────────────────
  if (!probe) {
    let last = -1;
    for (;;) {
      const page = await phdb.query<SourceRevision>(
        `${REV_SELECT} WHERE id > $1 ORDER BY id LIMIT ${String(PAGE)}`,
        [last],
      );
      if (page.rows.length === 0) break;
      for (const r of page.rows) {
        await store.importRevision({
          ...r,
          id: Number(r.id),
          captured_at:
            r.captured_at === null ? null : r.captured_at.toISOString(),
        });
        stats.migrated_revisions += 1;
        last = Number(r.id);
      }
    }
    last = -1;
    for (;;) {
      const page = await phdb.query<SourceDelta>(
        `${DELTA_SELECT} WHERE d.id > $1 ORDER BY d.id LIMIT ${String(PAGE)}`,
        [last],
      );
      if (page.rows.length === 0) break;
      for (const d of page.rows) {
        await store.importDelta({
          ...d,
          id: Number(d.id),
          revision_id: Number(d.revision_id),
        });
        stats.migrated_deltas += 1;
        last = Number(d.id);
      }
    }
  }

  // ── Pass 2: parity — counts + per-row hash stream in id order ────────
  const srcCounts = await phdb.query<{ revs: string; deltas: string }>(
    `SELECT (SELECT COUNT(*) FROM history.file_revisions) AS revs,
            (SELECT COUNT(*) FROM history.revision_triple_deltas) AS deltas`,
  );
  stats.source_revisions = Number(srcCounts.rows[0]?.revs ?? 0);
  stats.source_deltas = Number(srcCounts.rows[0]?.deltas ?? 0);
  const destCounts = await store.counts();
  if (destCounts.revisions !== stats.source_revisions) {
    stats.parity_mismatches.push({
      table: "file_revisions",
      id: -1,
      reason: `count ${String(destCounts.revisions)} != source ${String(stats.source_revisions)}`,
    });
  }
  if (destCounts.deltas !== stats.source_deltas) {
    stats.parity_mismatches.push({
      table: "revision_deltas",
      id: -1,
      reason: `count ${String(destCounts.deltas)} != source ${String(stats.source_deltas)}`,
    });
  }

  // Revisions: stream both sides.
  let last = -1;
  for (;;) {
    const src = await phdb.query<SourceRevision>(
      `${REV_SELECT} WHERE id > $1 ORDER BY id LIMIT ${String(PAGE)}`,
      [last],
    );
    if (src.rows.length === 0) break;
    const ids = src.rows.map((r) => Number(r.id));
    const dst = await calliope.query<{
      id: string | number;
      file_path: string;
      commit_sha: string | null;
      git_blob_sha: string | null;
      summary: string | null;
      change_type: string | null;
    }>(
      `SELECT id, file_path, commit_sha, git_blob_sha, summary, change_type
         FROM file_revisions WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    const dstMap = new Map(dst.rows.map((r) => [Number(r.id), r]));
    for (const r of src.rows) {
      const d = dstMap.get(Number(r.id));
      if (
        d === undefined ||
        hashRow(revisionHashFields(r)) !== hashRow(revisionHashFields(d))
      ) {
        stats.parity_mismatches.push({
          table: "file_revisions",
          id: Number(r.id),
          reason: d === undefined ? "missing at destination" : "hash mismatch",
        });
      }
      last = Number(r.id);
    }
  }

  // Deltas: stream both sides (source labels re-joined identically).
  last = -1;
  for (;;) {
    const src = await phdb.query<SourceDelta>(
      `${DELTA_SELECT} WHERE d.id > $1 ORDER BY d.id LIMIT ${String(PAGE)}`,
      [last],
    );
    if (src.rows.length === 0) break;
    const ids = src.rows.map((r) => Number(r.id));
    const dst = await calliope.query<SourceDelta>(
      `SELECT id, revision_id, op, subject, predicate, object
         FROM revision_deltas WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    const dstMap = new Map(dst.rows.map((r) => [Number(r.id), r]));
    for (const s of src.rows) {
      const d = dstMap.get(Number(s.id));
      const srcHash = hashRow([
        Number(s.revision_id),
        s.op,
        s.subject,
        s.predicate,
        s.object,
      ]);
      const dstHash =
        d === undefined
          ? ""
          : hashRow([
              Number(d.revision_id),
              d.op,
              d.subject,
              d.predicate,
              d.object,
            ]);
      if (srcHash !== dstHash) {
        stats.parity_mismatches.push({
          table: "revision_deltas",
          id: Number(s.id),
          reason: d === undefined ? "missing at destination" : "hash mismatch",
        });
      }
      last = Number(s.id);
    }
  }

  const artifact = {
    ran_at: new Date().toISOString(),
    mode: probe ? "probe" : "migrate",
    ...stats,
    parity_mismatch_count: stats.parity_mismatches.length,
    parity_mismatches: stats.parity_mismatches.slice(0, 50),
  };
  writeFileSync(EXPORT_PATH, JSON.stringify(artifact, null, 2));

  process.stderr.write(
    `migrate-revisions: src=${String(stats.source_revisions)}+${String(stats.source_deltas)} ` +
      `migrated=${String(stats.migrated_revisions)}+${String(stats.migrated_deltas)} ` +
      `mismatches=${String(stats.parity_mismatches.length)} artifact=${EXPORT_PATH}\n`,
  );

  await phdb.end();
  await calliope.end();
  if (stats.parity_mismatches.length > 0) process.exitCode = 1;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  run(process.argv.includes("--probe")).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`migrate-revisions: FATAL: ${message}\n`);
    process.exitCode = 1;
  });
}

export { run as runRevisionMigration };
