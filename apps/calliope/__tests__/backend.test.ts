import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, type Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  type Backend,
  backendKind,
  initBodyClient,
  makeBackend,
  makeBodyClient,
  pgPool,
  prepareBackend,
} from "../src/mcp/backend.js";
import {
  IndexingBodyClient,
  UraniaIndexClient,
} from "../src/mcp/index-push.js";
import { PgBodyClient } from "../src/pg-client.js";

describe("backendKind — backend selection from env", () => {
  it("returns 'fixture' when CALLIOPE_MCP_BACKEND=fixture", () => {
    expect(backendKind({ CALLIOPE_MCP_BACKEND: "fixture" })).toBe("fixture");
  });

  it("returns 'hades' when CALLIOPE_MCP_BACKEND=hades", () => {
    expect(backendKind({ CALLIOPE_MCP_BACKEND: "hades" })).toBe("hades");
  });

  it("returns 'urania' when CALLIOPE_MCP_BACKEND=urania (explicit)", () => {
    expect(backendKind({ CALLIOPE_MCP_BACKEND: "urania" })).toBe("urania");
  });

  it("auto-selects 'hades' when CALLIOPE_WRITE_VIA_HADES=1", () => {
    expect(backendKind({ CALLIOPE_WRITE_VIA_HADES: "1" })).toBe("hades");
  });

  it("auto-selects 'hades' when CALLIOPE_WRITE_VIA_HADES=true", () => {
    expect(backendKind({ CALLIOPE_WRITE_VIA_HADES: "true" })).toBe("hades");
  });

  it("auto-selects 'hades' when CHARON_URL is set (non-empty)", () => {
    expect(backendKind({ CHARON_URL: "http://charon:8300" })).toBe("hades");
  });

  it("defaults to 'pg' when no relevant env vars are set (F2 — the flip)", () => {
    expect(backendKind({})).toBe("pg");
  });

  it("still auto-selects 'pg' when DATABASE_URL is set", () => {
    expect(backendKind({ DATABASE_URL: "postgresql://x/y" })).toBe("pg");
  });

  it("CALLIOPE_MCP_BACKEND=fixture takes priority over CALLIOPE_WRITE_VIA_HADES", () => {
    expect(
      backendKind({
        CALLIOPE_MCP_BACKEND: "fixture",
        CALLIOPE_WRITE_VIA_HADES: "1",
      }),
    ).toBe("fixture");
  });

  it("CALLIOPE_MCP_BACKEND=urania takes priority over CALLIOPE_WRITE_VIA_HADES", () => {
    expect(
      backendKind({
        CALLIOPE_MCP_BACKEND: "urania",
        CALLIOPE_WRITE_VIA_HADES: "1",
      }),
    ).toBe("urania");
  });
});

describe("pg fail-fast — a missing DATABASE_URL refuses the boot (F2)", () => {
  it("makeBodyClient('pg') throws naming DATABASE_URL when it is absent", () => {
    expect(() => makeBodyClient("pg", {})).toThrow(/DATABASE_URL/);
  });

  it("makeBodyClient('pg') throws when DATABASE_URL is empty", () => {
    expect(() => makeBodyClient("pg", { DATABASE_URL: "" })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("makeBackend('pg') throws naming DATABASE_URL when it is absent", () => {
    expect(() => makeBackend("pg", {})).toThrow(/DATABASE_URL/);
  });
});

describe("initBodyClient", () => {
  it("unwraps the index-push decorator so ensureSchema reaches the pg store", async () => {
    const queries: string[] = [];
    const fakePool = {
      query: (sql: string) => {
        queries.push(sql);
        return Promise.resolve({ rows: [] });
      },
    } as unknown as ConstructorParameters<typeof PgBodyClient>[0];
    const wrapped = new IndexingBodyClient(
      new PgBodyClient(fakePool),
      new UraniaIndexClient("http://127.0.0.1:9"),
    );
    await initBodyClient(wrapped);
    // The schema bootstrap ran THROUGH the wrapper (the live 2026-07-12
    // finding: an instanceof check on the wrapper never fired).
    // F12: a fresh install bootstraps the blob store only — the old
    // model's DDL never runs outside the migration suite's legacy flag.
    expect(
      queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS blobs")),
    ).toBe(true);
    expect(
      queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS sections")),
    ).toBe(false);
  });
});

// F7: the sovereign store's login under STELLAR_DB_AUTH (stellar-core-ts
// dbauth). Nothing here dials: a pg Pool connects lazily, so its options are
// the whole observable — read through the tag store, which holds the ONE pool.
describe("F7 — the pg login follows STELLAR_DB_AUTH", () => {
  const root = mkdtempSync(join(tmpdir(), "calliope-dbauth-"));
  const caFile = join(root, "ca.crt");
  writeFileSync(caFile, "THE-CA");
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const svidUrl = `postgresql://calliope_svid@aether:5432/calliope?sslmode=verify-full&sslrootcert=${caFile}`;
  const identity = {
    current: () => ({ certPem: "SVID-CERT", keyPem: "SVID-KEY" }),
  };
  const poolOf = (backend: Backend): Pool =>
    (backend.tags as unknown as { pool: Pool }).pool;

  it("pgPool without a login is the bare DATABASE_URL", () => {
    const pool = pgPool({ DATABASE_URL: "postgresql://u:pw@aether/calliope" });
    expect(pool.options.connectionString).toBe(
      "postgresql://u:pw@aether/calliope",
    );
    expect(pool.options.Client).toBeUndefined();
  });

  it("pgPool without a login refuses a missing DATABASE_URL", () => {
    expect(() => pgPool({})).toThrow(/DATABASE_URL/);
  });

  it("kairos (unset): the pool dials the delivered DSN, no identity asked for", async () => {
    let opened = 0;
    const backend = await prepareBackend(
      "pg",
      { DATABASE_URL: "postgresql://v-calliope-1:pw@aether/calliope" },
      {
        source: () => {
          opened++;
          return Promise.resolve(identity);
        },
      },
    );
    const pool = poolOf(backend);
    expect(pool.options.connectionString).toBe(
      "postgresql://v-calliope-1:pw@aether/calliope",
    );
    expect(pool.options.Client).toBeUndefined();
    expect(opened).toBe(0);
  });

  it("svid: every facet's pool presents the live SVID, verify-full against the CA", async () => {
    const backend = await prepareBackend(
      "pg",
      { DATABASE_URL: svidUrl, STELLAR_DB_AUTH: "svid" },
      { source: () => Promise.resolve(identity), pollMs: 5 },
    );
    const pool = poolOf(backend);
    expect(pool.options.connectionString).toBe(
      "postgresql://calliope_svid@aether:5432/calliope",
    );
    const PoolClient = pool.options.Client;
    expect(PoolClient).toBeDefined();
    const client = new (PoolClient ?? Client)(pool.options);
    expect(client).toBeInstanceOf(Client);
    // pg hides `key` (non-enumerable) once it has the config, so it is
    // read by name rather than compared as part of the object.
    const ssl = (
      client as unknown as {
        connectionParameters: { ssl: Record<string, unknown> };
      }
    ).connectionParameters.ssl;
    expect(ssl).toEqual({
      ca: "THE-CA",
      cert: "SVID-CERT",
      rejectUnauthorized: true,
    });
    expect(ssl.key).toBe("SVID-KEY");
  });

  it("svid: the env the backend reads is the env the mode is read from", async () => {
    await expect(
      prepareBackend(
        "pg",
        {
          DATABASE_URL: "postgresql://u@aether/calliope",
          STELLAR_DB_AUTH: "svid",
        },
        { source: () => Promise.resolve(identity) },
      ),
    ).rejects.toThrow(/sslmode/);
  });

  it("svid: a missing DATABASE_URL still refuses by name", async () => {
    await expect(
      prepareBackend("pg", { STELLAR_DB_AUTH: "svid" }),
    ).rejects.toThrow(/DATABASE_URL/);
  });

  it("a non-pg backend asks nothing of the login", async () => {
    let opened = 0;
    const backend = await prepareBackend(
      "fixture",
      { STELLAR_DB_AUTH: "bogus" },
      {
        source: () => {
          opened++;
          return Promise.resolve(identity);
        },
      },
    );
    expect(backend.documents).toBeDefined();
    expect(opened).toBe(0);
  });
});
