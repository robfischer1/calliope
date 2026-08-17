/**
 * BlobStore conformance suite (spec 039, guarantees G1-G7) — runs against a
 * REAL ephemeral postgres, not a simulator: the expression-index ON CONFLICT
 * arbiter and concurrent-mint convergence are exactly what a fake would get
 * wrong. Skipped (with a visible reason) when docker is unavailable.
 */

import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgBodyClient } from "../src/pg-client.js";
import { BlobStore } from "../src/blob-store.js";

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const HAVE_DOCKER = dockerAvailable();

describe.skipIf(!HAVE_DOCKER)("BlobStore (real postgres)", () => {
  let containerId = "";
  let pool: Pool;
  let store: BlobStore;

  async function rowCount(): Promise<number> {
    const res = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM blobs`,
    );
    return res.rows[0]?.n ?? 0;
  }

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
    const schema = new PgBodyClient(pool);
    await schema.ensureSchema();
    // T001 acceptance: the bootstrap is idempotent — a second run is a no-op.
    await schema.ensureSchema();
    store = new BlobStore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (containerId)
      execSync(`docker rm -f ${containerId}`, { stdio: "ignore" });
  });

  // G6 — the store carries identity and text, nothing else.
  it("has exactly {id, text} as columns — no structural attribute", async () => {
    const res = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'blobs' ORDER BY column_name`,
    );
    expect(res.rows.map((r) => r.column_name)).toEqual(["id", "text"]);
  });

  // G1 — idempotent mint, duplicate writes nothing.
  it("mints once, dedupes forever (row count asserted)", async () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    const first = await store.mint(text);
    const before = await rowCount();
    const second = await store.mint(text);
    const third = await store.mint(text);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(await rowCount()).toBe(before);
  });

  // G2 — distinct bytes, distinct ids (incl. the unicode-normalization edge).
  it("gives distinct content distinct ids", async () => {
    const a = await store.mint("alpha paragraph");
    const b = await store.mint("beta paragraph");
    expect(a).not.toBe(b);
  });

  it("treats NFC and NFD forms as distinct blobs (byte identity)", async () => {
    const nfc = "caf\u00e9 identity test";
    const nfd = "cafe\u0301 identity test";
    const a = await store.mint(nfc);
    const b = await store.mint(nfd);
    expect(a).not.toBe(b);
    expect(await store.getText(a)).toBe(nfc);
    expect(await store.getText(b)).toBe(nfd);
  });

  // G3 — byte-exact round trip: empty, unicode, and beyond the btree ceiling.
  it("round-trips the empty blob", async () => {
    const id = await store.mint("");
    expect(await store.getText(id)).toBe("");
    expect(await store.mint("")).toBe(id);
  });

  it("dedupes multi-kilobyte prose (past the ~2.7KB btree row ceiling)", async () => {
    const big = "A long paragraph of durable prose. ".repeat(300); // ~10.5 KB
    const first = await store.mint(big);
    const before = await rowCount();
    const second = await store.mint(big);
    expect(second).toBe(first);
    expect(await rowCount()).toBe(before);
    expect(await store.getText(first)).toBe(big);
  });

  // G4 — absence is null, never a fabrication, never a throw.
  it("returns null for an id that names nothing", async () => {
    expect(await store.getText("999999999")).toBeNull();
  });

  it("returns null for content never stored", async () => {
    expect(await store.findByContent("never minted, never seen")).toBeNull();
  });

  it("finds stored content by bytes", async () => {
    const text = "content-probe target paragraph";
    const id = await store.mint(text);
    expect(await store.findByContent(text)).toBe(id);
  });

  // G5 — ranked FTS; empty result on no match.
  it("answers full-text queries ranked, [] on no match", async () => {
    const hitA = await store.mint("The zeppelin drifted over the harbor.");
    const hitB = await store.mint(
      "A zeppelin, another zeppelin, and a third zeppelin in formation.",
    );
    const miss = await store.mint("Nothing airborne in this sentence.");
    const hits = await store.search("zeppelin");
    const ids = hits.map((h) => h.id);
    expect(ids).toContain(hitA);
    expect(ids).toContain(hitB);
    expect(ids).not.toContain(miss);
    // ranked: the denser match sorts first
    expect(ids.indexOf(hitB)).toBeLessThan(ids.indexOf(hitA));
    expect(await store.search("xylophonequark")).toEqual([]);
  });

  // G7 — concurrent duplicate mints converge on one row.
  it("converges 32 concurrent mints of one text onto one row", async () => {
    const text = "concurrently minted paragraph, exactly one home";
    const before = await rowCount();
    const ids = await Promise.all(
      Array.from({ length: 32 }, () => store.mint(text)),
    );
    expect(new Set(ids).size).toBe(1);
    expect(await rowCount()).toBe(before + 1);
  });

  // 042 F5 SC-004 — the two-store read's blob half, measured: a
  // representative 50-block container's batched text fetch. The number is
  // recorded in specs/042-container-read/measurement.md.
  it("fetches a 50-block container's prose in one batched read (measured)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      ids.push(
        await store.mint(
          `Measurement block ${String(i)}: ` + "durable prose. ".repeat(64),
        ),
      );
    }
    const runs: number[] = [];
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      const texts = await store.getTexts(ids);
      runs.push(performance.now() - t0);
      expect(texts.size).toBe(50);
    }
    const mean = runs.reduce((a, b) => a + b, 0) / runs.length;

    console.log(
      `[measurement 042 SC-004] batched getTexts(50 x ~1KB): mean ${mean.toFixed(2)}ms over ${String(runs.length)} runs (${runs.map((r) => r.toFixed(1)).join(", ")})`,
    );
    expect(mean).toBeLessThan(250); // sanity ceiling, not the recorded number
  });

  // FR-001 — immutability: the module exposes no update/delete path. Static
  // guarantee (surface is mint/getText/findByContent/search only); assert the
  // surface here so a future verb addition trips this suite.
  it("exposes no mutating surface beyond mint", () => {
    const surface = Object.getOwnPropertyNames(BlobStore.prototype).sort();
    expect(surface).toEqual([
      "constructor",
      "findByContent",
      "getText",
      "getTexts", // 042 F5: the batched read — still a read
      "mint",
      "search",
    ]);
  });
});
