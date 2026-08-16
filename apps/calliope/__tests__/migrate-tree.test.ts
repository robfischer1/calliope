/**
 * F6 migration suite (spec 043) — the honest harness: the OLD store is a
 * REAL postgres exercised through PgBodyClient's own write API (true
 * old-model lineage: coarse saves, copy-on-write edits, reorders, deletes,
 * ops-only bodies, comments), the NEW stores are the fixture dial + blobs.
 * SC-001 parity (HEAD + every revision as-of), SC-002 idempotency, SC-003
 * drift refusal, SC-004 comments.
 */

import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { readContainer } from "../src/container-read.js";
import {
  COMMENTS_ON,
  migrateTree,
  type MigrateTreeDeps,
} from "../src/mcp/migrate-tree.js";
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
const NODE_A = "a1".repeat(32);
const NODE_B = "b2".repeat(32);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!HAVE_DOCKER)("migrate-tree (real old store)", () => {
  let containerId = "";
  let pool: Pool;
  let pg: PgBodyClient;
  let dial: FixtureChaosDial;
  let blobs: FixtureBlobStore;
  let deps: MigrateTreeDeps;
  let targetSectionId = "";

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
    pg = new PgBodyClient(pool);
    await pg.ensureSchema();

    // ── true old-model lineage ──────────────────────────────────────────
    // rev 1: coarse save, three blocks.
    await pg.saveBody(NODE_A, [
      { text: "alpha" },
      { text: "beta" },
      { text: "gamma" },
    ]);
    await sleep(5);
    // rev 2: copy-on-write edit of beta (re-mints the id + supersession).
    let body = await pg.readBody(NODE_A);
    const beta = body[1];
    if (beta === undefined) throw new Error("no beta");
    await pg.applySectionOps(NODE_A, [
      { op: "update", sectionId: beta.id, text: "beta, revised" },
    ]);
    await sleep(5);
    // rev 3: reorder alpha to the end.
    body = await pg.readBody(NODE_A);
    const alpha = body[0];
    const last = body[body.length - 1];
    if (alpha === undefined || last === undefined) throw new Error("bad body");
    await pg.applySectionOps(NODE_A, [
      { op: "reorder", sectionId: alpha.id, orderKey: last.orderKey + "V" },
    ]);
    await sleep(5);
    // rev 4: delete gamma.
    body = await pg.readBody(NODE_A);
    const gamma = body.find((s) => s.text === "gamma");
    if (gamma === undefined) throw new Error("no gamma");
    await pg.applySectionOps(NODE_A, [{ op: "delete", sectionId: gamma.id }]);
    await sleep(5);

    // An ops-only body (never coarse-saved — the anchor-coalesce case).
    await pg.applySectionOps(NODE_B, [
      { op: "add", text: "ops-only one", orderKey: "a0" },
      { op: "add", text: "ops-only two", orderKey: "a1" },
    ]);
    await sleep(5);

    // A comment on the revised beta, in A's comment container.
    body = await pg.readBody(NODE_A);
    const target = body.find((s) => s.text === "beta, revised");
    if (target === undefined) throw new Error("no target");
    targetSectionId = target.id;
    await pg.applySectionOps(`${NODE_A}#comments`, [
      { op: "add", text: "a thoughtful comment", orderKey: "a0" },
    ]);
    const comment = (await pg.readBody(`${NODE_A}#comments`))[0];
    if (comment === undefined) throw new Error("no comment");
    await pool.query(
      `INSERT INTO comments_on (comment_id, target_id, node_id)
       VALUES ($1, $2, $3)`,
      [comment.id, target.id, NODE_A],
    );

    dial = new FixtureChaosDial();
    blobs = new FixtureBlobStore();
    deps = { pg, pool, blobs, dial };
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (containerId)
      execSync(`docker rm -f ${containerId}`, { stdio: "ignore" });
  });

  it("probes without writing", async () => {
    const before = dial.admits.length;
    const report = await migrateTree(deps, { probe: true });
    expect(report.probe).toBe(true);
    expect(report.containers).toBe(3); // A, A#comments, B
    expect(dial.admits.length).toBe(before);
    expect(blobs.size).toBe(0);
  });

  it("migrates with full two-sided parity (SC-001)", async () => {
    const report = await migrateTree(deps);
    expect(report.parity_mismatches).toEqual([]);
    expect(report.refused).toEqual([]);
    expect(report.migrated).toBe(3);
    // The tenant graphs were ensured before any admit (live chaos would
    // refuse facts to an unregistered graph).
    expect([...dial.graphs].sort()).toEqual(["comments", "notes"]);

    const recA = report.per_container.find((c) => c.node === NODE_A);
    if (recA === undefined) throw new Error("no A record");
    expect(recA.status).toBe("migrated");
    expect(recA.revisions).toHaveLength(4);

    // HEAD parity, read back through the NEW model.
    const head = await readContainer({ blobs, dial }, recA.container);
    expect(head.blocks.map((b) => b.text)).toEqual(["beta, revised", "alpha"]);
    // As-of rev 1: the original three, original order.
    const rev1Tx = recA.revisions[0]?.tx;
    if (rev1Tx === null || rev1Tx === undefined) throw new Error("no tx");
    const past = await readContainer({ blobs, dial }, recA.container, {
      asOfTx: rev1Tx,
    });
    expect(past.blocks.map((b) => b.text)).toEqual(["alpha", "beta", "gamma"]);

    // The ops-only body migrated too.
    const recB = report.per_container.find((c) => c.node === NODE_B);
    expect(recB?.status).toBe("migrated");
    const headB = await readContainer({ blobs, dial }, NODE_B);
    expect(headB.blocks.map((b) => b.text)).toEqual([
      "ops-only one",
      "ops-only two",
    ]);
  });

  it("keeps original authorship in the graph (D2a, Rob 2026-08-16)", async () => {
    // NODE_A replayed four revisions in the earlier migration run; each
    // landed one migration_provenance fact in the bookkeeping batch. A
    // skipped re-run adds none (asserted by the count staying 4).
    const recA = (await migrateTree(deps)).per_container.find(
      (c) => c.node === NODE_A,
    );
    if (recA === undefined) throw new Error("no A record");
    expect(recA.status).toBe("skipped");
    const edges = await dial.edges(recA.container);
    const provenance = edges.filter(
      (e) => e.predicate === "migration_provenance",
    );
    expect(provenance).toHaveLength(4);
    for (const fact of provenance) {
      expect(fact.value).toMatch(/^tx=\d+ at=\d{4}-.+Z by=.+$/);
      expect(fact.domain).toBe("scalar");
    }
  });

  it("migrates the comment as a slot-to-slot fact (SC-004)", async () => {
    // Runs against the state the previous test built.
    const commentContainerRec = (await migrateTree(deps)).per_container.find(
      (c) => c.node === `${NODE_A}#comments`,
    );
    expect(commentContainerRec?.status).toBe("skipped"); // already migrated
    // Find the comment slot via its provenance and check the edge.
    const commentSlots = await dial.findByValue(
      "comments",
      "migrated_from_section",
      (await pg.readBody(`${NODE_A}#comments`))[0]?.id ?? "",
    );
    const commentSlot = commentSlots[0];
    if (commentSlot === undefined) throw new Error("comment slot missing");
    const edges = await dial.edges(commentSlot);
    const link = edges.find((e) => e.predicate === COMMENTS_ON);
    expect(link?.domain).toBe("node");
    const targetSlots = await dial.findByValue(
      "notes",
      "migrated_from_section",
      targetSectionId,
    );
    expect(link?.value).toBe(targetSlots[0]);
  });

  it("re-runs as a no-op (SC-002)", async () => {
    const admitsBefore = dial.admits.length;
    const blobsBefore = blobs.size;
    const report = await migrateTree(deps);
    expect(report.skipped).toBe(3);
    expect(report.migrated).toBe(0);
    expect(blobs.size).toBe(blobsBefore);
    // comments idempotency: the edge pre-check found it; zero NEW admits.
    expect(dial.admits.length).toBe(admitsBefore);
  });

  it("refuses a container whose old store drifted after migration (SC-003)", async () => {
    await pg.applySectionOps(NODE_B, [
      { op: "add", text: "written after the migration", orderKey: "a2" },
    ]);
    const report = await migrateTree(deps);
    const recB = report.per_container.find((c) => c.node === NODE_B);
    expect(recB?.status).toBe("refused_drift");
    expect(report.refused.some((r) => r.includes(NODE_B))).toBe(true);
    expect(report.refused.some((r) => r.includes("frozen"))).toBe(true);
  });
});
