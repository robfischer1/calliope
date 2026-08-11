/**
 * F12 — the offline tag index over a real temp directory: shared grammar,
 * F11 hygiene included, dot-directories skipped, node ids root-relative.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeFsTagIndex, fsListByTag, fsListTags } from "../src/fs-tags.js";

let root = "";

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "fs-tags-"));
  writeFileSync(
    path.join(root, "a.md"),
    "# A note\n\nwith #journal and #brain-soup inline",
  );
  mkdirSync(path.join(root, "sub"));
  writeFileSync(
    path.join(root, "sub", "b.md"),
    "another #journal carrier, plus junk #a6d189 and a color #fff",
  );
  writeFileSync(path.join(root, "sub", "not-a-body.txt"), "#ignored");
  mkdirSync(path.join(root, ".obsidian"));
  writeFileSync(path.join(root, ".obsidian", "hidden.md"), "#hidden");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("computeFsTagIndex (F12)", () => {
  it("aggregates inline tags with counts, root-relative carriers, hygiene applied", async () => {
    const { tags, byTag } = await computeFsTagIndex(root);
    expect(tags).toEqual([
      { tag: "#brain-soup", count: 1 },
      { tag: "#journal", count: 2 },
    ]);
    expect(byTag.get("#journal")).toEqual(["a.md", "sub/b.md"]);
    // Junk (hex shapes) never enters; dot-dirs and non-markdown are skipped.
    expect(byTag.has("#a6d189")).toBe(false);
    expect(byTag.has("#fff")).toBe(false);
    expect(byTag.has("#hidden")).toBe(false);
    expect(byTag.has("#ignored")).toBe(false);
  });

  it("fsListTags / fsListByTag serve the ferry shapes, normalized", async () => {
    expect(await fsListTags(root)).toEqual({
      tags: [
        { tag: "#brain-soup", count: 1 },
        { tag: "#journal", count: 2 },
      ],
    });
    expect(await fsListByTag(root, "Journal")).toEqual({
      tag: "#journal",
      node_ids: ["a.md", "sub/b.md"],
    });
    expect(await fsListByTag(root, "#nope")).toEqual({
      tag: "#nope",
      node_ids: [],
    });
  });
});
