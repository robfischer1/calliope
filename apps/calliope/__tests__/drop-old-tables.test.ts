/**
 * The gated drop (047 F12) — the cut refuses without a clean parity
 * report against a frozen store, and removes exactly the three replaced
 * tables when the gate passes. Docker-gated: a real postgres.
 */

import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { dropOldTables, gateDrop } from "../src/mcp/drop-old-tables.js";
import { PgBodyClient } from "../src/pg-client.js";

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dockerAvailable())("the gated drop (F12)", () => {
  let containerId = "";
  let pool: Pool;

  beforeAll(async () => {
    containerId = execSync(
      "docker run -d --rm -e POSTGRES_PASSWORD=test -e POSTGRES_DB=calliope" +
        " -p 127.0.0.1:0:5432 postgres:17-alpine",
      { encoding: "utf8" },
    ).trim();
    const portLine = execSync(`docker port ${containerId} 5432/tcp`, {
      encoding: "utf8",
    }).trim();
    const port = Number(portLine.split(":").pop());
    pool = new Pool({
      host: "127.0.0.1",
      port,
      user: "postgres",
      password: "test",
      database: "calliope",
    });
    for (let i = 0; ; i++) {
      try {
        await pool.query("SELECT 1");
        break;
      } catch (err) {
        if (i > 60) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const pg = new PgBodyClient(pool);
    await pg.ensureSchema({ legacy: true });
    // Two old-store containers, exactly what a clean report would cover.
    await pg.saveBody("a1".repeat(32), [{ text: "one" }]);
    await pg.saveBody("b2".repeat(32), [{ text: "two" }]);
  }, 120_000);

  afterAll(async () => {
    await pool.end().catch(() => undefined);
    if (containerId)
      execSync(`docker rm -f ${containerId}`, { stdio: "ignore" });
  });

  const clean = {
    containers: 2,
    migrated: 2,
    skipped: 0,
    refused: [],
    parity_mismatches: [],
  };

  it("refuses a report carrying refusals or mismatches", async () => {
    expect((await gateDrop(pool, { ...clean, refused: ["x: bad"] })).ok).toBe(
      false,
    );
    expect(
      (await gateDrop(pool, { ...clean, parity_mismatches: ["y"] })).ok,
    ).toBe(false);
  });

  it("refuses a report that does not account for every container", async () => {
    const verdict = await gateDrop(pool, { ...clean, migrated: 1 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/account/);
  });

  it("refuses when the live store moved past the report", async () => {
    const verdict = await gateDrop(pool, {
      ...clean,
      containers: 1,
      migrated: 1,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/AFTER the parity run/);
  });

  it("accepts the summary-report key spelling too", async () => {
    const verdict = await gateDrop(pool, {
      containers: 2,
      migrated: 1,
      skipped_already_migrated: 1,
      refused: [],
      parity_mismatches: [],
    });
    expect(verdict.ok).toBe(true);
  });

  it("passes the clean gate, drops the three tables, spares the rest", async () => {
    expect((await gateDrop(pool, clean)).ok).toBe(true);
    await dropOldTables(pool);
    for (const table of ["sections", "supersessions", "comments_on"]) {
      const res = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_tables WHERE tablename = $1`,
        [table],
      );
      expect(Number(res.rows[0]?.n)).toBe(0);
    }
    // The blob store is untouched — the cut removes ONLY the old model.
    await pool.query(`SELECT count(*) FROM blobs`);
    await pool.query(`SELECT count(*) FROM blob_gc_marks`);
  });
});
