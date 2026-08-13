import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chunk,
  isServedPath,
  normalizeBody,
  walkServed,
} from "../src/fs-search/chunker.js";
import {
  HL_CLOSE,
  HL_OPEN,
  SearchStore,
  toMatchExpression,
} from "../src/fs-search/store.js";

let dir: string;
let store: SearchStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fs-search-store-"));
  store = new SearchStore(path.join(dir, "search.sqlite"));
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("chunker", () => {
  it("splits on blank lines, hashes content, orders paragraphs", () => {
    const paragraphs = chunk(
      normalizeBody("first para\r\n\r\nsecond para\n\n\n"),
    );
    expect(paragraphs.map((p) => p.ord)).toEqual([0, 1]);
    expect(paragraphs.map((p) => p.text)).toEqual([
      "first para",
      "second para",
    ]);
    expect(paragraphs[0]?.hash).toHaveLength(64);
    expect(paragraphs[0]?.hash).not.toEqual(paragraphs[1]?.hash);
  });

  it("identical paragraphs share a hash (content-addressed dedupe)", () => {
    const [a, b] = chunk("same text\n\nsame text");
    expect(a?.hash).toEqual(b?.hash);
  });

  it("isServedPath refuses dotted segments and non-markdown", () => {
    expect(isServedPath("notes/a.md")).toBe(true);
    expect(isServedPath(".grace/search.sqlite")).toBe(false);
    expect(isServedPath("notes/.hidden/a.md")).toBe(false);
    expect(isServedPath("notes/a.txt")).toBe(false);
  });

  it("walkServed skips dotted dirs (the index never indexes itself)", async () => {
    await mkdir(path.join(dir, ".grace"), { recursive: true });
    await mkdir(path.join(dir, "notes"), { recursive: true });
    await writeFile(path.join(dir, ".grace", "junk.md"), "x", "utf8");
    await writeFile(path.join(dir, "notes", "real.md"), "hello", "utf8");
    const files = await walkServed(dir);
    expect(files.map((f) => f.path)).toEqual(["notes/real.md"]);
    expect(files[0]?.size).toBeGreaterThan(0);
  });
});

describe("SearchStore", () => {
  it("upsert reports only missing hashes; unchanged paragraphs need no re-embed", async () => {
    const v1 = chunk("alpha\n\nbeta");
    const first = await store.upsertFile("a.md", 1, 10, v1);
    expect(first.missing).toHaveLength(2);
    for (const p of v1) {
      await store.putVector(p.hash, new Int8Array(384), "test-model");
    }
    // One paragraph edited: only ITS new hash is missing.
    const v2 = chunk("alpha\n\nbeta CHANGED");
    const second = await store.upsertFile("a.md", 2, 12, v2);
    expect(second.missing).toEqual([v2[1]?.hash]);
  });

  it("fts search returns marked snippets and dedupes to best block per path", async () => {
    await store.upsertFile(
      "a.md",
      1,
      1,
      chunk("the heron lands at dusk\n\nheron again here"),
    );
    await store.upsertFile("b.md", 1, 1, chunk("nothing relevant"));
    const hits = await store.ftsSearch("heron", undefined, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("a.md");
    expect(hits[0]?.snippet).toContain(`${HL_OPEN}heron${HL_CLOSE}`);
  });

  it("scope filters by subtree prefix", async () => {
    await store.upsertFile("notes/in.md", 1, 1, chunk("heron inside"));
    await store.upsertFile("out.md", 1, 1, chunk("heron outside"));
    const hits = await store.ftsSearch("heron", "notes", 10);
    expect(hits.map((h) => h.path)).toEqual(["notes/in.md"]);
  });

  it("removeFile keeps FTS in sync and sweeps orphaned vectors", async () => {
    const paragraphs = chunk("unique seagull phrase");
    await store.upsertFile("gone.md", 1, 1, paragraphs);
    const hash = paragraphs[0]?.hash ?? "";
    await store.putVector(hash, new Int8Array(384), "test-model");
    await store.removeFile("gone.md");
    expect(await store.ftsSearch("seagull", undefined, 10)).toHaveLength(0);
    expect(await store.embeddedBlocks()).toHaveLength(0);
    expect(await store.fileCount()).toBe(0);
  });

  it("dropForeignVectors clears a different nominal model's space", async () => {
    const paragraphs = chunk("some text");
    await store.upsertFile("a.md", 1, 1, paragraphs);
    await store.putVector(
      paragraphs[0]?.hash ?? "",
      new Int8Array(384),
      "old-model",
    );
    const dropped = await store.dropForeignVectors("new-model");
    expect(dropped).toBe(1);
    expect(await store.embeddedBlocks()).toHaveLength(0);
  });

  it("toMatchExpression quotes terms (no FTS5 syntax injection)", () => {
    expect(toMatchExpression('heron AND "quoted" (paren)')).toBe(
      '"heron" "AND" "quoted" "paren"',
    );
    expect(toMatchExpression("  ")).toBe("");
  });
});
