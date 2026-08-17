/**
 * Local search on the engine's postgres (046 F14) — tsvector FTS, the
 * decided local search substrate ("Eros stays local via tsvector +
 * pgvector"). The semantic arm follows pgvector into the payload and is
 * NAMED dark until then. Docker-gated: a real postgres, fixture engine.
 */

import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { LocalEngineStore } from "../src/local-store.js";

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dockerAvailable())("local search (pg tsvector)", () => {
  let containerId = "";
  let pool: Pool;
  let root: string;
  let store: LocalEngineStore;

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
    root = await mkdtemp(path.join(tmpdir(), "local-search-"));
    store = new LocalEngineStore(
      root,
      { blobs: new FixtureBlobStore(), dial: new FixtureChaosDial() },
      { pool, watch: false },
    );

    await store.saveBody("Ideas/blobs.md", [
      { text: "The blob store dedupes prose by content hash." },
    ]);
    await store.saveBody("Ideas/trees.md", [
      { text: "A tree of slots orders blocks; see [[blobs]] for the store." },
    ]);
    await store.saveBody("Journal/monday.md", [
      { text: "Nothing about storage here, only breakfast." },
    ]);
  }, 120_000);

  afterAll(async () => {
    store.close();
    await pool.end().catch(() => undefined);
    if (containerId)
      execSync(`docker rm -f ${containerId}`, { stdio: "ignore" });
    await rm(root, { recursive: true, force: true });
  });

  it("FTS answers ranked hits with snippets; semantic arm named dark", async () => {
    const res = await store.search("blob store");
    expect(res.armsQueried).toEqual(["fts"]);
    expect(res.armsDark).toEqual(["semantic"]);
    expect(res.hits.length).toBeGreaterThanOrEqual(2);
    expect(res.hits[0]?.id).toBe("Ideas/blobs.md");
    expect(res.hits[0]?.snippet).toContain("blob");
    expect(res.hits.map((h) => h.id)).not.toContain("Journal/monday.md");
  });

  it("scope narrows by path prefix", async () => {
    const res = await store.search("storage OR store", "Journal/");
    expect(res.hits.map((h) => h.id)).toEqual(["Journal/monday.md"]);
  });

  it("mentions: wikilinks are linked, text matches are unlinked", async () => {
    const res = await store.mentions("Ideas/blobs.md");
    expect(res.linked.map((m) => m.id)).toEqual(["Ideas/trees.md"]);
    // The FTS candidates never repeat the linked or the note itself.
    expect(res.unlinked.map((m) => m.id)).not.toContain("Ideas/trees.md");
    expect(res.unlinked.map((m) => m.id)).not.toContain("Ideas/blobs.md");
  });

  it("an external edit re-indexes on ingest", async () => {
    await writeFile(
      path.join(root, "Journal", "monday.md"),
      "surprise: a rogue blob appears",
      "utf8",
    );
    await store.readBody("Journal/monday.md"); // ingest + re-index
    const res = await store.search("rogue blob");
    expect(res.hits.map((h) => h.id)).toContain("Journal/monday.md");
  });

  it("a deleted note leaves the index", async () => {
    const { unlink } = await import("node:fs/promises");
    await unlink(path.join(root, "Journal", "monday.md"));
    await store.readBody("Journal/monday.md");
    const res = await store.search("rogue blob");
    expect(res.hits.map((h) => h.id)).not.toContain("Journal/monday.md");
  });
});
