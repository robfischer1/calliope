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
import {
  LiveChaosDial,
  notesScope,
  opRemove,
  type ChaosDial,
  type ChaosOp,
} from "../chaos-client.js";
import { assertAdditiveAttrs, sinkNoteVersion } from "../notes-sink.js";
import type { DocumentRow } from "../document-store.js";

/** One migration run's outcome — the numbers the report pastes. */
export interface MigrateNotesReport {
  paths: number;
  /** Distinct note identities this run covered (≥ paths once archive rows split). */
  identities: number;
  versions: number;
  minted: number;
  superseded: number;
  nooped: number;
  /** Identities carrying the isArchived exclusion predicate. */
  archived: number;
  /** Stale container-path mega-notes unwound THIS run (empty when converged). */
  unwound: string[];
  parity_mismatches: string[];
}

/**
 * The note identity a row belongs to (Rob's F7 decision, 2026-08-10).
 *
 * Vault-shaped rows keep `source_path` — the F6 model, unchanged. The
 * phdb-migration corpus used `source_path` as a source CONTAINER field
 * (`F:\OneDrive` = 1,900 distinct documents), so those rows key on
 * `source_path :: (file_path | title | raw_hash prefix)` and carry the
 * `isArchived` exclusion predicate. The ` :: ` joiner never appears in a
 * vault path, so the two families cannot collide.
 */
/** Every predicate the sink family writes — the unwind's retraction set. */
const SINK_PREDICATES = new Set([
  "hasName",
  "hasType",
  "parent",
  "hasTag",
  "source_path",
  "raw_hash",
  "source_kind",
  "mtime",
  "ctime",
  "title",
  "schema_type",
  "file_path",
  "dissolved_at",
  "isArchived",
  "document_id",
]);

export function identityOf(row: DocumentRow): {
  name: string;
  archived: boolean;
} {
  if (row.source_kind !== "phdb-migration") {
    return { name: row.source_path, archived: false };
  }
  const disc = row.file_path ?? row.title ?? row.raw_hash.slice(0, 12);
  return { name: `${row.source_path} :: ${disc}`, archived: true };
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
  /** Delete a note's store rows (sections, lineage, tag mirror) — the pg
   *  half of the unwind; the graph half (edge retraction) rides the dial. */
  unwindNote?: (nodeId: string) => Promise<void>,
): Promise<MigrateNotesReport> {
  const paths = await store.listSourcePaths();
  const report: MigrateNotesReport = {
    paths: paths.length,
    identities: 0,
    versions: 0,
    minted: 0,
    superseded: 0,
    nooped: 0,
    archived: 0,
    unwound: [],
    parity_mismatches: [],
  };

  for (const sourcePath of paths) {
    // bySourcePath answers newest-first; versions land oldest-first so the
    // newest ends as the active generation.
    const all = [...(await store.bySourcePath(sourcePath))].reverse();

    // Group rows by note identity (first-seen order). Vault rows keep the
    // bare path; archive rows split per document.
    const groups = new Map<
      string,
      { archived: boolean; rows: DocumentRow[] }
    >();
    for (const row of all) {
      const id = identityOf(row);
      const group = groups.get(id.name) ?? {
        archived: id.archived,
        rows: [],
      };
      group.rows.push(row);
      groups.set(id.name, group);
    }

    // Unwind the F6-era mega-note: when EVERY row of this path is archive
    // material, the bare-path name is a stale identity from the first
    // migration — retract its edges (graph) and delete its rows (store).
    // Idempotent: a re-run finds no edges and reports nothing.
    if (
      all.length > 0 &&
      all.every((r) => identityOf(r).archived) &&
      !groups.has(sourcePath)
    ) {
      const [stale] = await dial.findByName("Note", sourcePath);
      if (stale !== undefined) {
        // Retract ONLY the predicates the sink family wrote. System edges
        // (ownedBy — the substrate's tenancy stamp) are not ours to
        // retract, and the substrate re-asserts them: retracting them made
        // every re-run "unwind" 442 phantom batches forever (measured on
        // the first live run — the loop this allowlist ends).
        const edges = (await dial.edges(stale)).filter((e) =>
          SINK_PREDICATES.has(e.predicate),
        );
        const ops: ChaosOp[] = edges.map((e) =>
          opRemove(
            stale,
            e.predicate,
            e.isNode ? { toNode: e.value } : { toLiteral: e.value },
          ),
        );
        if (ops.length > 0) {
          const res = await dial.admit(ops, scope);
          if (!res.admitted) {
            throw new Error(
              `migrate-notes: the gate refused the unwind batch for ` +
                `${sourcePath}: ${JSON.stringify(res.violations)}`,
            );
          }
          report.unwound.push(sourcePath);
        }
        await unwindNote?.(stale);
      }
    }

    for (const [name, group] of groups) {
      report.identities += 1;
      if (group.archived) report.archived += 1;
      const versions = group.rows;
      const documentIds: [string, string][] = versions.map((r) => [
        "document_id",
        String(r.id),
      ]);

      // Convergence check — a naive replay would THRASH a converged store
      // (re-sinking v1 supersedes the active v2, then v2 supersedes v1
      // again: two junk generations per run). An identity is converged iff
      // the note exists, its active body is byte-identical to the newest
      // version, and it carries at least one generation per stored version.
      // Exact because (source_path, raw_hash) is UNIQUE within an identity.
      const newestRow = versions.at(-1);
      const [standing] = await dial.findByName("Note", name);
      if (standing !== undefined && newestRow !== undefined) {
        const activeBody = await client.readBody(standing);
        const activeText = activeBody.map((s) => s.text).join("\n");
        const events = await client.readRevisions(
          standing,
          versions.length + 1,
        );
        if (
          activeBody.length === 1 &&
          activeText === newestRow.body_text &&
          events.length >= versions.length
        ) {
          report.versions += versions.length;
          report.nooped += versions.length;
          // The id-handle bridge must exist even on converged skips — the
          // F6 run predates document_id edges.
          await assertAdditiveAttrs(dial, scope, standing, documentIds);
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
          {
            identity: name,
            ...(group.archived
              ? { extraAttrs: new Map([["isArchived", "true"]]) }
              : {}),
            additiveAttrs: [["document_id", String(row.id)]],
          },
        );
        nodeId = result.node_id;
        report.versions += 1;
        report[result.generation] += 1;
      }

      // The parity gate: active body === newest stored version, byte-exact.
      const newest = versions.at(-1);
      if (nodeId !== null && newest !== undefined) {
        const body = await client.readBody(nodeId);
        const active = body.map((s) => s.text).join("\n");
        if (body.length !== 1 || active !== newest.body_text) {
          report.parity_mismatches.push(name);
        }
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
    const unwindNote = async (nodeId: string): Promise<void> => {
      await pool.query("DELETE FROM sections WHERE node_id = $1", [nodeId]);
      await pool.query("DELETE FROM supersessions WHERE node_id = $1", [
        nodeId,
      ]);
      await pool.query("DELETE FROM note_tags WHERE node_id = $1", [nodeId]);
    };
    const report = await migrateNotes(
      store,
      client,
      dial,
      notesScope(process.env),
      tags,
      unwindNote,
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
