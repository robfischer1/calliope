/**
 * PgBodyClient contract tests — run against a REAL ephemeral postgres
 * (docker-run in setup), not a simulator: COLLATE "C" ordering and
 * transaction semantics are exactly what the carve must not get wrong.
 * Skipped (with a visible reason) when docker is unavailable.
 */

import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgBodyClient } from "../src/pg-client.js";

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const HAVE_DOCKER = dockerAvailable();

describe.skipIf(!HAVE_DOCKER)("PgBodyClient (real postgres)", () => {
  let containerId = "";
  let pool: Pool;
  let client: PgBodyClient;

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
    // Readiness: retry until postgres accepts a query (fresh container).
    for (let i = 0; ; i++) {
      try {
        await pool.query("SELECT 1");
        break;
      } catch (err) {
        if (i > 60) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    client = new PgBodyClient(pool);
    await client.ensureSchema();
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (containerId)
      execSync(`docker rm -f ${containerId}`, { stdio: "ignore" });
  });

  it("reads an empty body as []", async () => {
    expect(await client.readBody("node-empty")).toEqual([]);
  });

  it("coarse-saves and reads back in order (COLLATE C)", async () => {
    await client.saveBody("node-a", [
      { text: "first" },
      { text: "second" },
      { text: "third" },
    ]);
    const body = await client.readBody("node-a");
    expect(body.map((s) => s.text)).toEqual(["first", "second", "third"]);
    expect(body.map((s) => s.orderKey)).toEqual(
      [...body.map((s) => s.orderKey)].sort(),
    );
    for (const s of body) expect(s.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a re-save replaces the body and deactivates priors (versions kept)", async () => {
    await client.saveBody("node-b", [{ text: "v1" }]);
    const v1 = await client.readBody("node-b");
    await client.saveBody("node-b", [{ text: "v2-a" }, { text: "v2-b" }]);
    const v2 = await client.readBody("node-b");
    expect(v2.map((s) => s.text)).toEqual(["v2-a", "v2-b"]);
    expect(v2.some((s) => s.id === v1[0]?.id)).toBe(false);
    const all = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM sections WHERE node_id = 'node-b'",
    );
    expect(all.rows[0]?.n).toBe(3); // v1 row retained inactive
  });

  it("editSection copy-on-writes: new id, same orderKey, lineage recorded", async () => {
    await client.saveBody("node-c", [{ text: "keep" }, { text: "edit me" }]);
    const before = await client.readBody("node-c");
    const target = before.at(1);
    if (target === undefined) throw new Error("fixture body missing");
    const edited = await client.editSection("node-c", target.id, "edited");
    expect(edited.id).not.toBe(target.id);
    expect(edited.orderKey).toBe(target.orderKey);
    const after = await client.readBody("node-c");
    expect(after.map((s) => s.text)).toEqual(["keep", "edited"]);
    expect(after.at(0)?.id).toBe(before.at(0)?.id); // untouched sibling keeps identity
    const lineage = await pool.query<{ supersedes: string | null }>(
      "SELECT supersedes FROM sections WHERE id = $1",
      [edited.id],
    );
    expect(lineage.rows[0]?.supersedes).toBe(target.id);
  });

  it("editSection rejects a stale/foreign section id", async () => {
    await client.saveBody("node-d", [{ text: "only" }]);
    await expect(
      client.editSection("node-d", "0".repeat(64), "nope"),
    ).rejects.toThrow(/is not part of node/);
  });

  it("persists authored_by per version", async () => {
    const human = new PgBodyClient(pool, "human");
    await human.saveBody("node-e", [{ text: "by hand" }]);
    const row = await pool.query<{ authored_by: string }>(
      "SELECT authored_by FROM sections WHERE node_id = 'node-e' AND active",
    );
    expect(row.rows[0]?.authored_by).toBe("human");
  });

  it("one section object can belong to two owners (twin nodes)", async () => {
    const shared = { id: "e".repeat(64), text: "shared body", orderKey: "01" };
    await client.importSection("twin-ulid", shared);
    await client.importSection("twin-hash", shared);
    expect(await client.readBody("twin-ulid")).toEqual([shared]);
    expect(await client.readBody("twin-hash")).toEqual([shared]);
    // Editing under ONE owner must not disturb the other's row.
    const edited = await client.editSection("twin-ulid", shared.id, "diverged");
    expect(edited.orderKey).toBe("01");
    expect(await client.readBody("twin-hash")).toEqual([shared]);
    expect((await client.readBody("twin-ulid")).at(0)?.text).toBe("diverged");
  });

  it("readRevisions lists write-events newest first with kinds (A8)", async () => {
    await client.saveBody("node-r", [{ text: "r1-a" }, { text: "r1-b" }]);
    const v1 = await client.readBody("node-r");
    const target = v1.at(1);
    if (target === undefined) throw new Error("fixture body missing");
    await client.editSection("node-r", target.id, "r1-b-edited");
    await client.saveBody("node-r", [{ text: "r2-only" }]);

    const revs = await client.readRevisions("node-r");
    expect(revs.map((r) => r.kind)).toEqual(["save", "edit", "save"]);
    expect(revs.map((r) => r.sections)).toEqual([1, 1, 2]);
    expect(revs.every((r) => r.authoredBy === "human")).toBe(true);
    // Newest first, strictly descending.
    const stamps = revs.map((r) => r.revision);
    expect([...stamps].sort().reverse()).toEqual(stamps);
  });

  it("readRevisionAt reconstructs each moment of the lineage (A8)", async () => {
    await client.saveBody("node-s", [{ text: "s1-a" }, { text: "s1-b" }]);
    const v1 = await client.readBody("node-s");
    const target = v1.at(0);
    if (target === undefined) throw new Error("fixture body missing");
    await client.editSection("node-s", target.id, "s1-a-edited");
    await client.saveBody("node-s", [{ text: "s2-x" }, { text: "s2-y" }]);

    const revs = await client.readRevisions("node-s");
    const [atSave2, atEdit, atSave1] = revs;
    if (!atSave2 || !atEdit || !atSave1) throw new Error("missing revisions");

    expect(
      (await client.readRevisionAt("node-s", atSave1.revision)).map(
        (s) => s.text,
      ),
    ).toEqual(["s1-a", "s1-b"]);
    expect(
      (await client.readRevisionAt("node-s", atEdit.revision)).map(
        (s) => s.text,
      ),
    ).toEqual(["s1-a-edited", "s1-b"]);
    expect(
      (await client.readRevisionAt("node-s", atSave2.revision)).map(
        (s) => s.text,
      ),
    ).toEqual(["s2-x", "s2-y"]);
    // The latest revision reconstructs to the live body.
    expect(await client.readRevisionAt("node-s", atSave2.revision)).toEqual(
      await client.readBody("node-s"),
    );
    // A moment before the body existed reconstructs to [].
    expect(
      await client.readRevisionAt("node-s", "2000-01-01T00:00:00.000000Z"),
    ).toEqual([]);
  });

  it("importSection preserves ids and is idempotent; retainOnly converges", async () => {
    const sec = { id: "f".repeat(64), text: "migrated", orderKey: "01" };
    await client.importSection("node-m", sec);
    await client.importSection("node-m", sec); // idempotent
    const body = await client.readBody("node-m");
    expect(body).toEqual([sec]);
    await client.retainOnly("node-m", [sec.id]);
    expect(await client.readBody("node-m")).toEqual([sec]);
    await client.retainOnly("node-m", []);
    expect(await client.readBody("node-m")).toEqual([]);
  });
});

describe.skipIf(HAVE_DOCKER)("PgBodyClient (docker unavailable)", () => {
  it("skipped — no docker on this runner", () => {
    expect(HAVE_DOCKER).toBe(false);
  });
});
