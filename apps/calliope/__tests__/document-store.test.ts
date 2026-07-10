/**
 * C3 document-store contract tests — the dedup/idempotency semantics the
 * dissolve sink promises, over BOTH impls: the in-memory fixture and (when
 * docker is available) a REAL ephemeral postgres, mirroring the pg-client
 * suite's harness.
 */

import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  FixtureDocumentStore,
  PgDocumentStore,
  sha256,
  type DocumentStore,
} from "../src/document-store.js";

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const HAVE_DOCKER = dockerAvailable();

/** The contract both stores must satisfy (FR-001/FR-002). */
function contractSuite(makeStore: () => Promise<DocumentStore>): void {
  it("stores a document verbatim and reads it back", async () => {
    const store = await makeStore();
    const res = await store.write({
      source_path: "Brain Soup/A Note.md",
      body_text: "# A Note\n\nprose body — verbatim.",
      subject: "A Note",
      schema_type: "DigitalDocument",
      mtime: "2026-07-01",
    });
    expect(res.ok).toBe(true);
    expect(res.table).toBe("documents");
    expect(res.deduped).toBe(false);
    expect(res.id).not.toBeNull();

    const row = await store.byId(res.id ?? -1);
    expect(row?.body_text).toBe("# A Note\n\nprose body — verbatim.");
    expect(row?.title).toBe("A Note");
    expect(row?.content_hash).toBe(
      sha256("# A Note\n\nprose body — verbatim."),
    );
    expect(row?.mtime).toBe("2026-07-01");
  });

  it("dedups an identical re-submit (idempotent dissolve retry)", async () => {
    const store = await makeStore();
    const first = await store.write({
      source_path: "Inbox/Same.md",
      body_text: "same content",
    });
    const second = await store.write({
      source_path: "Inbox/Same.md",
      body_text: "same content",
    });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.id).toBeNull();
    const rows = await store.bySourcePath("Inbox/Same.md");
    expect(rows).toHaveLength(1);
  });

  it("a changed body at the same path is a NEW row (content-versioned)", async () => {
    const store = await makeStore();
    await store.write({ source_path: "Inbox/Evolving.md", body_text: "v1" });
    await store.write({ source_path: "Inbox/Evolving.md", body_text: "v2" });
    const rows = await store.bySourcePath("Inbox/Evolving.md");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.body_text))).toEqual(
      new Set(["v1", "v2"]),
    );
  });

  it("lists newest-first with schema_type filter and omit_body", async () => {
    const store = await makeStore();
    await store.write({
      source_path: "a.md",
      body_text: "doc a",
      schema_type: "DigitalDocument",
    });
    await store.write({
      source_path: "b.md",
      body_text: "dataset b",
      schema_type: "Dataset",
    });
    const all = await store.list();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const datasets = await store.list({ schema_type: "Dataset" });
    expect(datasets.every((r) => r.schema_type === "Dataset")).toBe(true);
    const index = await store.list({ omit_body: true });
    expect(index.every((r) => r.body_text === "")).toBe(true);
    // content_hash survives omit_body — the parity anchor stays readable.
    expect(index.every((r) => r.content_hash.length === 64)).toBe(true);
  });
}

describe("FixtureDocumentStore (contract)", () => {
  contractSuite(() => Promise.resolve(new FixtureDocumentStore()));
});

describe.skipIf(!HAVE_DOCKER)("PgDocumentStore (real postgres)", () => {
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
    // Fresh table per test — the contract suite assumes an empty store.
    await pool.query("DROP TABLE IF EXISTS documents");
    const store = new PgDocumentStore(pool);
    await store.ensureSchema();
    return store;
  });
});
