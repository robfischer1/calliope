import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSearchIndex } from "../src/fs-search/index.js";
import { FakeEmbedder } from "./fs-search-index.test.js";

let root: string;
let index: LocalSearchIndex | null = null;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fs-search-incr-"));
});

afterEach(async () => {
  index?.close();
  index = null;
  await rm(root, { recursive: true, force: true });
});

describe("SC-003 — one forward pass per edited block", () => {
  it("editing one paragraph of one file re-embeds exactly that paragraph", async () => {
    await writeFile(path.join(root, "a.md"), "alpha one\n\nalpha two", "utf8");
    await writeFile(path.join(root, "b.md"), "beta one\n\nbeta two", "utf8");
    await writeFile(path.join(root, "c.md"), "gamma only", "utf8");
    const embedder = new FakeEmbedder();
    index = LocalSearchIndex.open(root, { embedder, watch: false });
    await index.awaitIdle();
    expect(embedder.texts).toHaveLength(5); // the full corpus, once

    // Edit ONE paragraph of ONE file.
    await writeFile(
      path.join(root, "a.md"),
      "alpha one\n\nalpha two EDITED",
      "utf8",
    );
    await index.catchUp();
    await index.awaitIdle();

    expect(embedder.texts).toHaveLength(6);
    expect(embedder.texts[5]).toBe("alpha two EDITED");
  });

  it("a pure rename of content (same text) costs zero re-embeds", async () => {
    await writeFile(path.join(root, "a.md"), "stable paragraph", "utf8");
    const embedder = new FakeEmbedder();
    index = LocalSearchIndex.open(root, { embedder, watch: false });
    await index.awaitIdle();
    expect(embedder.texts).toHaveLength(1);

    // The same content under a second path: content-addressed → no new embed.
    await writeFile(path.join(root, "copy.md"), "stable paragraph", "utf8");
    await index.catchUp();
    await index.awaitIdle();
    expect(embedder.texts).toHaveLength(1);
  });
});
