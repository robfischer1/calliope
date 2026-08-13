import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIMS, type Embedder } from "../src/fs-search/encoder.js";
import { HL_OPEN } from "../src/fs-search/store.js";
import { LocalSearchIndex } from "../src/fs-search/index.js";

/** Deterministic fake: vector derived from the text's hash; counts calls. */
export class FakeEmbedder implements Embedder {
  readonly model = "fake-model";
  texts: string[] = [];
  embed(texts: string[]): Promise<Int8Array[]> {
    this.texts.push(...texts);
    const vectors = texts.map((t) => {
      const digest = createHash("sha256").update(t).digest();
      const v = new Int8Array(DIMS);
      for (let i = 0; i < DIMS; i++) {
        const b = digest[i % digest.length] ?? 0;
        v[i] = (b % 27) - 13;
      }
      return v;
    });
    return Promise.resolve(vectors);
  }
}

let root: string;
let index: LocalSearchIndex | null = null;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fs-search-index-"));
});

afterEach(async () => {
  index?.close();
  index = null;
  await rm(root, { recursive: true, force: true });
});

describe("LocalSearchIndex", () => {
  it("US1: finds the note containing a phrase, both arms fused, offline", async () => {
    await writeFile(
      path.join(root, "heron.md"),
      "the heron lands at dusk",
      "utf8",
    );
    await writeFile(
      path.join(root, "other.md"),
      "unrelated prose entirely",
      "utf8",
    );
    index = LocalSearchIndex.open(root, {
      embedder: new FakeEmbedder(),
      watch: false,
    });
    await index.awaitIdle();
    const res = await index.search("heron dusk");
    expect(res.armsQueried.sort()).toEqual(["fts", "semantic"]);
    expect(res.armsDark).toEqual([]);
    expect(res.hits[0]?.id).toBe("heron.md");
    expect(res.hits[0]?.snippet).toContain(HL_OPEN);
    expect(res.hits[0]?.arms).toContain("fts");
  });

  it("US2: no encoder → FTS answers and the semantic arm is NAMED dark", async () => {
    await writeFile(path.join(root, "a.md"), "findable text here", "utf8");
    index = LocalSearchIndex.open(root, { embedder: null, watch: false });
    await index.started;
    const res = await index.search("findable");
    expect(res.armsQueried).toEqual(["fts"]);
    expect(res.armsDark).toEqual(["semantic"]);
    expect(res.hits[0]?.id).toBe("a.md");
  });

  it("zero matches with arms up is distinct from dark arms", async () => {
    await writeFile(path.join(root, "a.md"), "something", "utf8");
    index = LocalSearchIndex.open(root, {
      embedder: new FakeEmbedder(),
      watch: false,
    });
    await index.awaitIdle();
    const res = await index.search("zzzzqqqq nonexistent");
    expect(res.hits).toEqual([]);
    expect(res.armsQueried).toContain("fts");
    expect(res.armsDark).toEqual([]);
  });

  it("scope restricts to a subtree prefix", async () => {
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(
      path.join(root, "notes", "in.md"),
      "target phrase inside",
      "utf8",
    );
    await writeFile(path.join(root, "out.md"), "target phrase outside", "utf8");
    index = LocalSearchIndex.open(root, {
      embedder: new FakeEmbedder(),
      watch: false,
    });
    await index.awaitIdle();
    const res = await index.search("target phrase", "notes");
    expect(res.hits.map((h) => h.id)).toEqual(["notes/in.md"]);
  });

  it("empty query refuses", async () => {
    index = LocalSearchIndex.open(root, { embedder: null, watch: false });
    await index.started;
    await expect(index.search("   ")).rejects.toThrow(/bad_request/);
  });

  it("freshness: an external change converges (watcher or sweep)", async () => {
    index = LocalSearchIndex.open(root, {
      embedder: null,
      watch: true,
      debounceMs: 30,
      sweepMs: 150,
    });
    await index.started;
    await writeFile(path.join(root, "late.md"), "a very late arrival", "utf8");
    const deadline = Date.now() + 5000;
    for (;;) {
      const res = await index.search("late arrival");
      if (res.hits.some((h) => h.id === "late.md")) break;
      if (Date.now() > deadline) throw new Error("index never converged");
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it("noteWritten (the FsBodyClient hook) indexes immediately without a watcher", async () => {
    index = LocalSearchIndex.open(root, { embedder: null, watch: false });
    await index.started;
    await writeFile(
      path.join(root, "hooked.md"),
      "written through the client",
      "utf8",
    );
    index.noteWritten("hooked.md");
    const deadline = Date.now() + 2000;
    for (;;) {
      const res = await index.search("written through client");
      if (res.hits.some((h) => h.id === "hooked.md")) break;
      if (Date.now() > deadline) throw new Error("hook never indexed");
      await new Promise((r) => setTimeout(r, 20));
    }
  });
});
