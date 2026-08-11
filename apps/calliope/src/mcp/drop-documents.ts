#!/usr/bin/env bun
/**
 * F7 — the strangler's last cut: DROP the `documents` table.
 *
 * Refuses without `--execute`, and refuses even then unless the note store
 * has CONVERGED against the table: every table row's id must resolve to a
 * note through the `document_id` bridge attributes. The check is the exact
 * inverse of the migration's write — nothing is inferred.
 *
 * OPERATOR GATE (not checkable from here): the DEPLOYED calliope image must
 * already serve the notes-backed reads (this feature's merge), because the
 * old image reads the table. Check the running STELLAR_REVISION first.
 *
 *   bun run src/mcp/drop-documents.ts             # probe: convergence report
 *   bun run src/mcp/drop-documents.ts --execute   # verify, then DROP
 */

import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { LiveChaosDial, notesScope } from "../chaos-client.js";

export interface DropProbe {
  rows: number;
  resolvable: number;
  unresolvable_ids: number[];
  converged: boolean;
}

/** Verify every table row resolves note-side via its document_id bridge. */
export async function probeConvergence(
  pool: Pool,
  dial: LiveChaosDial,
  scope: string,
): Promise<DropProbe> {
  const res = await pool.query<{ id: string | number }>(
    "SELECT id FROM documents ORDER BY id",
  );
  const unresolvable: number[] = [];
  for (const r of res.rows) {
    const id = Number(r.id);
    const hits = await dial.findByValue(scope, "document_id", String(id));
    if (hits.length === 0) unresolvable.push(id);
  }
  return {
    rows: res.rows.length,
    resolvable: res.rows.length - unresolvable.length,
    unresolvable_ids: unresolvable.slice(0, 20),
    converged: unresolvable.length === 0,
  };
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl === undefined || dbUrl === "") {
    throw new Error("DATABASE_URL is required.");
  }
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const dial = new LiveChaosDial();
    const probe = await probeConvergence(pool, dial, notesScope(process.env));
    process.stdout.write(`${JSON.stringify(probe)}\n`);
    if (!execute) return;
    if (!probe.converged) {
      process.stderr.write(
        "drop-documents: REFUSED — unresolvable rows remain; run the " +
          "migration to convergence first.\n",
      );
      process.exitCode = 1;
      return;
    }
    await pool.query("DROP TABLE documents");
    process.stdout.write(`${JSON.stringify({ dropped: true })}\n`);
  } finally {
    await pool.end();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `drop-documents: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
