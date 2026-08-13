/**
 * Findability F11 (spec 037) — mentions over the index: true linked
 * mentions (never extent-bounded), unlinked candidates minus the linkers,
 * self excluded, alias/heading/path link forms normalized.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractWikilinks } from "../src/fs-search/chunker.js";
import { LocalSearchIndex } from "../src/fs-search/index.js";

let root: string;
let index: LocalSearchIndex | null = null;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fs-search-mentions-"));
});

afterEach(async () => {
  index?.close();
  index = null;
  await rm(root, { recursive: true, force: true });
});

describe("extractWikilinks", () => {
  it("normalizes alias, heading, and path forms to the note name", () => {
    expect(
      extractWikilinks(
        "see [[The Heron]] and [[Notes/The Heron|the bird]] and [[the heron#Habits]]",
      ),
    ).toEqual(["the heron", "the heron", "the heron"]);
  });

  it("ignores non-links and empties", () => {
    expect(extractWikilinks("no links [here] or [[]]")).toEqual([]);
  });
});

describe("mentions", () => {
  it("linked mentions are corpus-wide; unlinked candidates exclude linkers and self", async () => {
    await writeFile(
      path.join(root, "the-heron.md"),
      "I am the note about the heron",
      "utf8",
    );
    await writeFile(
      path.join(root, "linker.md"),
      "See [[the-heron]] for details",
      "utf8",
    );
    await writeFile(
      path.join(root, "casual.md"),
      "the-heron came up in conversation without a link",
      "utf8",
    );
    await writeFile(path.join(root, "unrelated.md"), "nothing here", "utf8");
    index = LocalSearchIndex.open(root, { embedder: null, watch: false });
    await index.started;
    const res = await index.mentions("the-heron.md");
    expect(res.linked.map((m) => m.id)).toEqual(["linker.md"]);
    const unlinkedIds = res.unlinked.map((m) => m.id);
    expect(unlinkedIds).toContain("casual.md");
    expect(unlinkedIds).not.toContain("linker.md"); // already linked
    expect(unlinkedIds).not.toContain("the-heron.md"); // self
    expect(unlinkedIds).not.toContain("unrelated.md");
  });

  it("a re-index moves a link (edit removes it → mention gone)", async () => {
    await writeFile(path.join(root, "t.md"), "target prose", "utf8");
    await writeFile(path.join(root, "l.md"), "link: [[t]]", "utf8");
    index = LocalSearchIndex.open(root, { embedder: null, watch: false });
    await index.started;
    expect((await index.mentions("t.md")).linked.map((m) => m.id)).toEqual([
      "l.md",
    ]);
    await writeFile(path.join(root, "l.md"), "link removed", "utf8");
    await index.catchUp();
    expect((await index.mentions("t.md")).linked).toEqual([]);
  });
});
