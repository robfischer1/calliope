/**
 * The blob store's SQL contract and the fixture's search, pinned without a
 * database: a recording pool captures each statement and its bind values, so
 * what the Pg classes ASK the database (the statement, the parameters, the
 * order) is asserted next to what they answer. Also the census's report of a
 * reporter that failed.
 */

import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { runBlobCensus } from "../src/blob-census.js";
import {
  BlobStore,
  FixtureBlobGc,
  FixtureBlobStore,
  PgBlobGc,
} from "../src/blob-store.js";
import { FixtureChaosDial } from "../src/chaos-client.js";

interface Answer {
  rows: unknown[];
  rowCount?: number | null;
}

/** A pool that records `{sql, params}` (whitespace collapsed) and answers the
 *  queued answers in order, then an empty one. */
function recordingPool(...answers: Answer[]) {
  const calls: { sql: string; params: unknown[] | undefined }[] = [];
  const queue = [...answers];
  const pool = {
    query: (sql: string, params?: unknown[]) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      return Promise.resolve(queue.shift() ?? { rows: [] });
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe("FixtureBlobStore.search", () => {
  it("answers every blob whose text holds the query, unranked, in id order", async () => {
    const s = new FixtureBlobStore();
    const a = await s.mint("alpha beta");
    await s.mint("gamma");
    const c = await s.mint("beta delta");
    expect(await s.search("beta")).toStrictEqual([
      { id: a, rank: 0 },
      { id: c, rank: 0 },
    ]);
  });

  it("answers nothing for a query no text holds", async () => {
    const s = new FixtureBlobStore();
    await s.mint("alpha");
    expect(await s.search("zzz")).toStrictEqual([]);
  });

  it("answers nothing for an empty query, though every text contains it", async () => {
    const s = new FixtureBlobStore();
    await s.mint("alpha");
    expect(await s.search("")).toStrictEqual([]);
  });

  it("answers an empty list from an empty store", async () => {
    expect(await new FixtureBlobStore().search("x")).toStrictEqual([]);
  });
});

describe("BlobStore.search binds the query and the limit", () => {
  it("passes the query and the default limit of 20", async () => {
    const { pool, calls } = recordingPool({ rows: [] });
    await new BlobStore(pool).search("zeppelin");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toStrictEqual(["zeppelin", 20]);
  });

  it("passes a limit that is given", async () => {
    const { pool, calls } = recordingPool({ rows: [] });
    await new BlobStore(pool).search("zeppelin", 5);
    expect(calls[0]?.params).toStrictEqual(["zeppelin", 5]);
  });
});

describe("PgBlobGc asks the database for exactly what it reports", () => {
  it("maxId reads max(id) as text and answers it", async () => {
    const { pool, calls } = recordingPool({ rows: [{ max: "42" }] });
    expect(await new PgBlobGc(pool).maxId()).toBe("42");
    expect(calls).toStrictEqual([
      { sql: "SELECT max(id)::text AS max FROM blobs", params: undefined },
    ]);
  });

  it("maxId answers null for a null max and for no row at all", async () => {
    expect(
      await new PgBlobGc(recordingPool({ rows: [{ max: null }] }).pool).maxId(),
    ).toBeNull();
    expect(
      await new PgBlobGc(recordingPool({ rows: [] }).pool).maxId(),
    ).toBeNull();
  });

  it("listIdsUpTo binds the bound and answers the ids in row order", async () => {
    const { pool, calls } = recordingPool({
      rows: [{ id: "1" }, { id: "2" }, { id: "5" }],
    });
    expect(await new PgBlobGc(pool).listIdsUpTo("7")).toStrictEqual([
      "1",
      "2",
      "5",
    ]);
    expect(calls).toStrictEqual([
      {
        sql: "SELECT id FROM blobs WHERE id <= $1 ORDER BY id",
        params: ["7"],
      },
    ]);
  });

  it("readMarks reads the mark ids in order and answers them", async () => {
    const { pool, calls } = recordingPool({ rows: [{ id: "3" }, { id: "9" }] });
    expect(await new PgBlobGc(pool).readMarks()).toStrictEqual(["3", "9"]);
    expect(calls).toStrictEqual([
      {
        sql: "SELECT id FROM blob_gc_marks ORDER BY id",
        params: undefined,
      },
    ]);
  });

  it("writeMarks clears the marks, then inserts the ids as one bigint array", async () => {
    const { pool, calls } = recordingPool();
    await new PgBlobGc(pool).writeMarks(["4", "8"]);
    expect(calls).toStrictEqual([
      { sql: "DELETE FROM blob_gc_marks", params: undefined },
      {
        sql:
          "INSERT INTO blob_gc_marks (id) SELECT unnest($1::bigint[]) " +
          "ON CONFLICT (id) DO NOTHING",
        params: [["4", "8"]],
      },
    ]);
  });

  it("writeMarks with no ids only clears the marks", async () => {
    const { pool, calls } = recordingPool();
    await new PgBlobGc(pool).writeMarks([]);
    expect(calls).toStrictEqual([
      { sql: "DELETE FROM blob_gc_marks", params: undefined },
    ]);
  });

  it("reap deletes the blobs and then their marks, and answers the blobs deleted", async () => {
    const { pool, calls } = recordingPool(
      { rows: [], rowCount: 2 },
      { rows: [], rowCount: 9 },
    );
    expect(await new PgBlobGc(pool).reap(["1", "2"])).toBe(2);
    expect(calls).toStrictEqual([
      {
        sql: "DELETE FROM blobs WHERE id = ANY($1::bigint[])",
        params: [["1", "2"]],
      },
      {
        sql: "DELETE FROM blob_gc_marks WHERE id = ANY($1::bigint[])",
        params: [["1", "2"]],
      },
    ]);
  });

  it("reap with no ids touches nothing", async () => {
    const { pool, calls } = recordingPool();
    expect(await new PgBlobGc(pool).reap([])).toBe(0);
    expect(calls).toStrictEqual([]);
  });
});

describe("FixtureBlobGc.maxId", () => {
  it("is the highest id once ids exist and null on an empty store", async () => {
    const s = new FixtureBlobStore();
    const gc = new FixtureBlobGc(s);
    expect(await gc.maxId()).toBeNull();
    await s.mint("a");
    await s.mint("b");
    expect(await gc.maxId()).toBe("2");
  });
});

describe("the census reports a reporter that failed", () => {
  it("names the graph, ok false, count 0 and the error text", async () => {
    const dial = new FixtureChaosDial();
    dial.failHeldBlobs = true;
    const store = new FixtureBlobStore();
    const report = await runBlobCensus(
      { gc: new FixtureBlobGc(store), dial },
      { roster: ["notes", "threads"] },
    );
    expect(report.complete).toBe(false);
    expect(report.reporters).toStrictEqual([
      {
        graph: "notes",
        ok: false,
        count: 0,
        error: "held_blobs: fixture refuses",
      },
      {
        graph: "threads",
        ok: false,
        count: 0,
        error: "held_blobs: fixture refuses",
      },
    ]);
  });
});
