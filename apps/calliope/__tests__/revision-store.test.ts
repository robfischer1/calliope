/**
 * C4 revision-store contract tests — id-preserving import idempotency and
 * the read surface, over both impls (fixture always; real postgres when
 * docker is available — the house harness).
 */

import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  FixtureRevisionStore,
  PgRevisionStore,
  type RevisionStore,
} from "../src/revision-store.js";

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const HAVE_DOCKER = dockerAvailable();

const REV = {
  id: 101,
  schema_type: "FileRevision",
  repo: "vault",
  commit_sha: "abc123",
  file_path: "Brain Soup/A Note.md",
  prior_file_path: null,
  change_type: "modified",
  authorship: "human",
  summary: "Sharpened the thesis.",
  summary_model: "m",
  summary_generated_at: null,
  git_blob_sha: "blob1",
  parent_blob_sha: "blob0",
  captured_at: "2026-05-20T12:00:00.000Z",
};

function contractSuite(makeStore: () => Promise<RevisionStore>): void {
  it("imports id-preserved and re-import is a no-op", async () => {
    const store = await makeStore();
    await store.importRevision(REV);
    await store.importRevision({ ...REV, summary: "OVERWRITE ATTEMPT" });
    const rows = await store.revisions({ id: 101 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("Sharpened the thesis."); // first write wins
    expect((await store.counts()).revisions).toBe(1);
  });

  it("queries by path newest-first with blob shas intact", async () => {
    const store = await makeStore();
    await store.importRevision(REV);
    await store.importRevision({
      ...REV,
      id: 102,
      captured_at: "2026-05-21T12:00:00.000Z",
      git_blob_sha: "blob2",
      parent_blob_sha: "blob1",
    });
    const rows = await store.revisions({ file_path: "Brain Soup/A Note.md" });
    expect(rows.map((r) => r.id)).toEqual([102, 101]);
    expect(rows[0]?.git_blob_sha).toBe("blob2");
  });

  it("serves a revision's deltas in stored order", async () => {
    const store = await makeStore();
    await store.importRevision(REV);
    await store.importDelta({
      id: 2,
      revision_id: 101,
      op: "add",
      subject: "A Note",
      predicate: "links_to",
      object: "Another Note",
    });
    await store.importDelta({
      id: 1,
      revision_id: 101,
      op: "remove",
      subject: "A Note",
      predicate: "tag",
      object: "stale",
    });
    const deltas = await store.deltasFor(101);
    expect(deltas.map((d) => d.id)).toEqual([1, 2]);
    expect(deltas[1]?.object).toBe("Another Note");
    expect((await store.counts()).deltas).toBe(2);
  });
}

describe("FixtureRevisionStore (contract)", () => {
  contractSuite(() => Promise.resolve(new FixtureRevisionStore()));
});

describe.skipIf(!HAVE_DOCKER)("PgRevisionStore (real postgres)", () => {
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
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (containerId !== "") {
      execSync(`docker stop ${containerId}`, { stdio: "ignore" });
    }
  });

  contractSuite(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS file_revisions; DROP TABLE IF EXISTS revision_deltas",
    );
    const store = new PgRevisionStore(pool);
    await store.ensureSchema();
    return store;
  });
});
