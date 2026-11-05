/**
 * The blob store's reap surface and the census's bookkeeping, pinned at the
 * contract: what a reap counts and forgets, what a candidate list holds, what
 * the census marks, reaps and reports. The Pg classes are driven through a
 * stub pool that answers fixed rows, so the row-mapping code is asserted
 * without a database.
 */

import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { runBlobCensus } from "../src/blob-census.js";
import {
  FixtureBlobGc,
  FixtureBlobStore,
  type GcStore,
  PgBlobGc,
  BlobStore,
} from "../src/blob-store.js";
import {
  type ChaosDial,
  FixtureChaosDial,
  tenantScope,
} from "../src/chaos-client.js";
import {
  FixtureDocumentStore,
  PgDocumentStore,
} from "../src/document-store.js";

const stubPool = (answer: { rows: unknown[]; rowCount?: number | null }) =>
  ({ query: () => Promise.resolve(answer) }) as unknown as Pool;

describe("FixtureBlobStore", () => {
  it("getTexts answers only the ids it holds", async () => {
    const s = new FixtureBlobStore();
    const a = await s.mint("alpha");
    const out = await s.getTexts([a, "999"]);
    expect([...out.keys()]).toEqual([a]);
    expect(out.has("999")).toBe(false);
  });

  it("reapIds counts what it removed, forgets the text, and skips unknown ids", async () => {
    const s = new FixtureBlobStore();
    const a = await s.mint("alpha");
    const b = await s.mint("beta");
    expect(s.reapIds([a, "999", b])).toBe(2);
    expect(s.reapIds([a])).toBe(0);
    expect(s.size).toBe(0);
    expect(await s.findByContent("alpha")).toBeNull();
    // The text is mintable again, under a fresh id that reads back.
    const again = await s.mint("alpha");
    expect(again).not.toBe(a);
    expect(await s.getText(again)).toBe("alpha");
  });
});

describe("FixtureBlobGc", () => {
  async function three() {
    const s = new FixtureBlobStore();
    for (const t of ["one", "two", "three"]) await s.mint(t);
    return { s, gc: new FixtureBlobGc(s) };
  }

  it("lists only the ids up to the snapshot, ascending", async () => {
    const { gc } = await three();
    expect(await gc.listIdsUpTo("2")).toEqual(["1", "2"]);
    expect(await gc.listIdsUpTo("3")).toEqual(["1", "2", "3"]);
    expect(await gc.listIdsUpTo("0")).toEqual([]);
    expect(await gc.maxId()).toBe("3");
    expect(await new FixtureBlobGc(new FixtureBlobStore()).maxId()).toBeNull();
  });

  it("a reap drops exactly the reaped ids from the marks", async () => {
    const { s, gc } = await three();
    await gc.writeMarks(["1", "2", "3"]);
    expect(await gc.reap(["2"])).toBe(1);
    expect(await gc.readMarks()).toEqual(["1", "3"]);
    expect(s.size).toBe(2);
  });
});

describe("the Pg classes map their rows", () => {
  it("BlobStore.search answers id and rank per row", async () => {
    const store = new BlobStore(
      stubPool({
        rows: [
          { id: "7", rank: 0.5 },
          { id: "3", rank: 0.25 },
        ],
      }),
    );
    expect(await store.search("q")).toEqual([
      { id: "7", rank: 0.5 },
      { id: "3", rank: 0.25 },
    ]);
  });

  it("PgBlobGc.reap answers the deleted row count, 0 when the driver gives none", async () => {
    expect(
      await new PgBlobGc(stubPool({ rows: [], rowCount: 3 })).reap(["1"]),
    ).toBe(3);
    expect(
      await new PgBlobGc(stubPool({ rows: [], rowCount: null })).reap(["1"]),
    ).toBe(0);
    expect(
      await new PgBlobGc(stubPool({ rows: [], rowCount: 9 })).reap([]),
    ).toBe(0);
  });

  it("PgDocumentStore.listSourcePaths answers the paths in row order", async () => {
    const store = new PgDocumentStore(
      stubPool({ rows: [{ source_path: "a.md" }, { source_path: "b.md" }] }),
    );
    expect(await store.listSourcePaths()).toEqual(["a.md", "b.md"]);
  });
});

describe("FixtureDocumentStore.byId", () => {
  it("finds the row with that id, not the first row", async () => {
    const s = new FixtureDocumentStore();
    await s.write({ source_path: "a.md", body_text: "one" });
    await s.write({ source_path: "b.md", body_text: "two" });
    expect((await s.byId(2))?.source_path).toBe("b.md");
    expect((await s.byId(1))?.source_path).toBe("a.md");
    expect(await s.byId(3)).toBeNull();
  });
});

describe("the census's bookkeeping", () => {
  function setup() {
    const dial = new FixtureChaosDial();
    const blobs = new FixtureBlobStore();
    return { dial, blobs, gc: new FixtureBlobGc(blobs) };
  }

  it("an empty store marks nothing and lists nothing", async () => {
    const { dial, gc } = setup();
    const r = await runBlobCensus({ gc, dial }, { execute: true });
    expect(r.marked).toEqual([]);
    expect(r.reaped).toEqual([]);
    expect(r.dangling).toEqual([]);
    expect(await gc.readMarks()).toEqual([]);
  });

  it("an empty store never asks for a candidate list", async () => {
    const { dial } = setup();
    let asked = 0;
    const gc: GcStore = {
      maxId: () => Promise.resolve(null),
      listIdsUpTo: () => {
        asked += 1;
        return Promise.resolve([]);
      },
      readMarks: () => Promise.resolve([]),
      writeMarks: () => Promise.resolve(),
      reap: () => Promise.resolve(0),
    };
    await runBlobCensus({ gc, dial });
    expect(asked).toBe(0);
  });

  it("the first complete round marks but reaps nothing, even when asked to execute", async () => {
    const { dial, blobs, gc } = setup();
    const id = await blobs.mint("orphan");
    const r1 = await runBlobCensus({ gc, dial }, { execute: true });
    expect(r1.executed).toBe(true);
    expect(r1.reaped).toEqual([]);
    expect(r1.marked).toEqual([id]);
    expect(blobs.size).toBe(1);
  });

  it("a marked orphan is spared when execute is not asked, and the reaped leave the marks", async () => {
    const { dial, blobs, gc } = setup();
    const id = await blobs.mint("orphan");
    await runBlobCensus({ gc, dial });
    const dry = await runBlobCensus({ gc, dial });
    expect(dry.executed).toBe(false);
    expect(dry.reaped).toEqual([]);
    expect(dry.marked).toEqual([id]);
    expect(blobs.size).toBe(1);
    const wet = await runBlobCensus({ gc, dial }, { execute: true });
    expect(wet.reaped).toEqual([id]);
    expect(wet.marked).toEqual([]);
    expect(await gc.readMarks()).toEqual([]);
  });

  it("a held blob the store has is not dangling", async () => {
    const { dial, blobs, gc } = setup();
    const id = await blobs.mint("kept");
    const held = {
      heldBlobs: (g?: string) =>
        Promise.resolve(g === tenantScope("notes") ? [id] : []),
    } as unknown as ChaosDial;
    const r = await runBlobCensus({ gc, dial: held });
    expect(r.held).toBe(1);
    expect(r.dangling).toEqual([]);
    expect(r.marked).toEqual([]);
    void dial;
  });

  it("dangling ids come back in numeric order, not insertion or text order", async () => {
    const { blobs, gc } = setup();
    await blobs.mint("only");
    const held = {
      heldBlobs: (g?: string) =>
        Promise.resolve(
          g === tenantScope("notes") ? ["10", "9", "100", "2"] : [],
        ),
    } as unknown as ChaosDial;
    const r = await runBlobCensus({ gc, dial: held });
    expect(r.dangling).toEqual(["2", "9", "10", "100"]);
  });
});
