#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

interface ParityReport {
  containers: number;
  migrated: number;
  skipped?: number;
  skipped_already_migrated?: number;
  refused: unknown[];
  parity_mismatches: unknown[];
}

export interface DropVerdict {
  ok: boolean;
  reason: string;
  containers?: number;
  live?: number;
}

/** The gate: does this report warrant the drop, against THIS live store? */
export async function gateDrop(
  pool: Pool,
  report: ParityReport,
): Promise<DropVerdict> {
  if (report.refused.length > 0) {
    return {
      ok: false,
      reason: `report carries ${String(report.refused.length)} refusal(s)`,
    };
  }
  if (report.parity_mismatches.length > 0) {
    return {
      ok: false,
      reason: `report carries ${String(report.parity_mismatches.length)} parity mismatch(es)`,
    };
  }
  const skipped = report.skipped ?? report.skipped_already_migrated ?? 0;
  if (report.migrated + skipped !== report.containers) {
    return {
      ok: false,
      reason:
        `report does not account for every container ` +
        `(${String(report.migrated)} migrated + ${String(skipped)} skipped ` +
        `!= ${String(report.containers)})`,
    };
  }
  const res = await pool.query<{ n: string }>(
    `SELECT count(DISTINCT node_id) AS n FROM sections`,
  );
  const live = Number(res.rows[0]?.n ?? -1);
  if (live !== report.containers) {
    return {
      ok: false,
      reason:
        `the live store holds ${String(live)} containers but the report ` +
        `covered ${String(report.containers)} — the old store was written ` +
        `AFTER the parity run; re-run the migration first`,
      containers: report.containers,
      live,
    };
  }
  return {
    ok: true,
    reason: "parity report clean and the store is frozen",
    containers: report.containers,
    live,
  };
}

/** The cut itself: one transaction, three tables. */
export async function dropOldTables(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DROP TABLE IF EXISTS comments_on");
    await client.query("DROP TABLE IF EXISTS supersessions");
    await client.query("DROP TABLE IF EXISTS sections");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const reportIdx = process.argv.indexOf("--report");
  const reportPath = reportIdx === -1 ? undefined : process.argv[reportIdx + 1];
  const execute = process.argv.includes("--execute");
  if (reportPath === undefined) {
    console.error("drop-old-tables: --report <parity-report.json> is required");
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") {
    console.error("drop-old-tables: DATABASE_URL is required");
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ParityReport;
  const pool = new Pool({ connectionString: url });
  try {
    const verdict = await gateDrop(pool, report);
    if (!verdict.ok) {
      console.error(`REFUSED: ${verdict.reason}`);
      process.exit(1);
    }
    if (!execute) {
      console.log(
        JSON.stringify({
          would_drop: ["comments_on", "supersessions", "sections"],
          gate: verdict,
          note: "dry run — pass --execute to cut",
        }),
      );
      return;
    }
    await dropOldTables(pool);
    console.log(
      JSON.stringify({
        dropped: ["comments_on", "supersessions", "sections"],
        gate: verdict,
      }),
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
