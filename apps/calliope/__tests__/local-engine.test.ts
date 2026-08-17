/**
 * Baby chaos end-to-end (spec 045 F13): the REAL engine, locally — a plain
 * postgres (no pgvector: the desktop payload's soft-vector case), the real
 * chaosstore binary, the themis-free LocalChaosDial, and the container
 * surface on top. This is the fleet's write/read model running with zero
 * fleet infrastructure.
 *
 * Gated on CALLIOPE_CHAOSSTORE_BIN (a locally built gostore/cmd/chaosstore)
 * plus docker; skips visibly otherwise.
 */

import { spawn, execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { BlobStore } from "../src/blob-store.js";
import { readContainer, containerHistory } from "../src/container-read.js";
import { writeContainer } from "../src/container-write.js";
import { LocalChaosDial } from "../src/local-admit.js";
import { PgBodyClient } from "../src/pg-client.js";
import { opCreate } from "../src/chaos-client.js";

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const BIN = process.env.CALLIOPE_CHAOSSTORE_BIN ?? "";
const RUN = dockerAvailable() && BIN !== "" && existsSync(BIN);

describe.skipIf(!RUN)("baby chaos: the local engine end to end", () => {
  let containerId = "";
  let store: ChildProcess | undefined;
  let pool: Pool;
  let dial: LocalChaosDial;
  let blobs: BlobStore;

  beforeAll(async () => {
    // A PLAIN postgres — no pgvector. The desktop payload's honest case:
    // soft-vector Migrate must carry the engine anyway.
    containerId = execSync(
      "docker run -d --rm -e POSTGRES_PASSWORD=test -e POSTGRES_DB=chaos" +
        " -p 127.0.0.1:0:5432 postgres:17-alpine",
      { encoding: "utf8" },
    ).trim();
    const portLine = execSync(`docker port ${containerId} 5432/tcp`, {
      encoding: "utf8",
    }).trim();
    const pgPort = Number(portLine.split(":").pop());
    const admin = new Pool({
      host: "127.0.0.1",
      port: pgPort,
      user: "postgres",
      password: "test",
      database: "chaos",
      max: 1,
    });
    for (let i = 0; ; i++) {
      try {
        await admin.query("SELECT 1");
        break;
      } catch (err) {
        if (i > 60) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await admin.query("CREATE DATABASE calliope");
    await admin.end();

    const chaosPort = 39000 + Math.floor(Math.random() * 4000);
    store = spawn(BIN, [], {
      env: {
        ...process.env,
        CHAOS_BIGINT_DATABASE_URL: `postgresql://postgres:test@127.0.0.1:${String(pgPort)}/chaos`,
        CHAOS_GO_MCP_ADDR: `127.0.0.1:${String(chaosPort)}`,
        CHAOS_GO_MCP_MTLS_ADDR: "127.0.0.1:0",
        KAFKA_BOOTSTRAP: "",
        CHAOS_GO_KAFKA_BOOTSTRAP: "",
        OTEL_SDK_DISABLED: "true",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderrTail = "";
    store.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    const chaosUrl = `http://127.0.0.1:${String(chaosPort)}`;
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(`${chaosUrl}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
          }),
        });
        if (res.ok) break;
      } catch {
        // booting
      }
      if (i > 60) {
        throw new Error(`chaosstore never came up. stderr: ${stderrTail}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    pool = new Pool({
      host: "127.0.0.1",
      port: pgPort,
      user: "postgres",
      password: "test",
      database: "calliope",
    });
    await new PgBodyClient(pool).ensureSchema();
    blobs = new BlobStore(pool);
    dial = new LocalChaosDial(chaosUrl);
    await dial.registerGraph("notes");
  }, 120_000);

  afterAll(async () => {
    await pool.end().catch(() => undefined);
    if (store?.exitCode === null) store.kill("SIGTERM");
    if (containerId)
      execSync(`docker rm -f ${containerId}`, { stdio: "ignore" });
  });

  it("writes and reads a container through the local engine", async () => {
    const minted = await dial.admit([opCreate("Note", "local doc")], "notes");
    const doc = minted.minted[0];
    if (doc === undefined) throw new Error("no container minted");

    const facet = { blobs, dial };
    const res = await writeContainer(facet, doc, [
      { op: "add", text: "the desktop's first block", position: "a0" },
      { op: "add", text: "and its second", position: "a1" },
    ]);
    expect(res.noop).toBe(false);

    const head = await readContainer(facet, doc);
    expect(head.blocks.map((b) => b.text)).toEqual([
      "the desktop's first block",
      "and its second",
    ]);
  });

  it("serves as-of history from the local graph", async () => {
    const minted = await dial.admit([opCreate("Note", "versioned")], "notes");
    const doc = minted.minted[0];
    if (doc === undefined) throw new Error("no container minted");
    const facet = { blobs, dial };

    await writeContainer(facet, doc, [
      { op: "add", text: "v1", position: "a0" },
    ]);
    const history1 = await containerHistory(facet, doc);
    const v1Tx = history1[history1.length - 1]?.tx;
    if (v1Tx === undefined) throw new Error("no v1 tx");

    const head1 = await readContainer(facet, doc);
    const slot = head1.blocks[0];
    if (slot?.blobId == null) throw new Error("no slot");
    await writeContainer(facet, doc, [
      { op: "update", slot: slot.slot, oldBlobId: slot.blobId, text: "v2" },
    ]);

    expect((await readContainer(facet, doc)).blocks.map((b) => b.text)).toEqual(
      ["v2"],
    );
    expect(
      (await readContainer(facet, doc, { asOfTx: v1Tx })).blocks.map(
        (b) => b.text,
      ),
    ).toEqual(["v1"]);
    const history = await containerHistory(facet, doc);
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it("dedupes prose across containers — one store, locally too", async () => {
    const a = await dial.admit([opCreate("Note", "dedupe a")], "notes");
    const b = await dial.admit([opCreate("Note", "dedupe b")], "notes");
    const [docA, docB] = [a.minted[0], b.minted[0]];
    if (docA === undefined || docB === undefined) throw new Error("no docs");
    const facet = { blobs, dial };
    const r1 = await writeContainer(facet, docA, [
      { op: "add", text: "shared paragraph", position: "a0" },
    ]);
    const r2 = await writeContainer(facet, docB, [
      { op: "add", text: "shared paragraph", position: "a0" },
    ]);
    expect(r1.blobIds[0]).toBe(r2.blobIds[0]);
  });
});
