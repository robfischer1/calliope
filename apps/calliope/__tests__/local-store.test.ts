/**
 * The local engine store (046 F14) — the desktop's one backend, on
 * fixtures: the engine is a FixtureChaosDial + FixtureBlobStore, the
 * working tree is a real temp directory. What's pinned here is the MODEL:
 * engine as store, markdown as projection, external edits as ingestion.
 */

import { readFile, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { extractWikilinks, LocalEngineStore } from "../src/local-store.js";

let root: string;
let dial: FixtureChaosDial;
let blobs: FixtureBlobStore;
let store: LocalEngineStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "local-store-"));
  dial = new FixtureChaosDial();
  blobs = new FixtureBlobStore();
  store = new LocalEngineStore(
    root,
    { blobs, dial },
    {
      pool: null,
      watch: false,
    },
  );
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("the store over the engine", () => {
  it("a missing file reads as an empty body", async () => {
    expect(await store.readBody("nothing.md")).toEqual([]);
  });

  it("saveBody writes the engine and projects the file", async () => {
    await store.saveBody("note.md", [{ text: "alpha" }, { text: "beta" }]);
    const body = await store.readBody("note.md");
    expect(body.map((s) => s.text)).toEqual(["alpha", "beta"]);
    // Two blocks project joined by the block separator.
    expect(await readFile(path.join(root, "note.md"), "utf8")).toBe(
      "alpha\n\nbeta",
    );
    // Slot identity is durable: a second identical save changes nothing.
    const before = body.map((s) => s.id);
    await store.saveBody("note.md", [{ text: "alpha" }, { text: "beta" }]);
    const after = (await store.readBody("note.md")).map((s) => s.id);
    expect(after).toEqual(before);
  });

  it("prose dedupes in the blob store across notes", async () => {
    await store.saveBody("a.md", [{ text: "shared paragraph" }]);
    await store.saveBody("b.md", [{ text: "shared paragraph" }]);
    expect(blobs.size).toBe(1);
  });

  it("an external edit ingests as ONE block (boundaries are user-stated)", async () => {
    await store.saveBody("note.md", [{ text: "one" }, { text: "two" }]);
    await writeFile(path.join(root, "note.md"), "rewritten\n\noutside", "utf8");
    const body = await store.readBody("note.md");
    expect(body.map((s) => s.text)).toEqual(["rewritten\n\noutside"]);
  });

  it("a deleted file empties the container — recoverable from history", async () => {
    await store.saveBody("note.md", [{ text: "doomed" }]);
    const revs = await store.readRevisions("note.md");
    await unlink(path.join(root, "note.md"));
    expect(await store.readBody("note.md")).toEqual([]);
    // The pre-deletion state is still an as-of read away.
    const last = revs[0];
    if (last === undefined) throw new Error("no revision");
    const at = await store.readRevisionAt("note.md", last.revision);
    expect(at.map((s) => s.text)).toEqual(["doomed"]);
  });

  it("editSection updates one block and refuses a stale id", async () => {
    await store.saveBody("note.md", [{ text: "a" }, { text: "b" }]);
    const [first] = await store.readBody("note.md");
    if (first === undefined) throw new Error("no body");
    const edited = await store.editSection("note.md", first.id, "A!");
    expect(edited.id).toBe(first.id);
    expect(await readFile(path.join(root, "note.md"), "utf8")).toBe("A!\n\nb");
    await expect(
      store.editSection("note.md", "ff".repeat(32), "x"),
    ).rejects.toThrow(/stale_section/);
  });

  it("applySectionOps maps add/update/delete/reorder onto tree ops", async () => {
    await store.saveBody("note.md", [{ text: "keep" }, { text: "drop" }]);
    const body = await store.readBody("note.md");
    const keep = body[0];
    const drop = body[1];
    if (keep === undefined || drop === undefined) throw new Error("no body");
    const result = await store.applySectionOps("note.md", [
      { op: "update", sectionId: keep.id, text: "kept, edited" },
      { op: "delete", sectionId: drop.id },
      { op: "add", text: "fresh tail", orderKey: "zz" },
    ]);
    expect(result.sections.map((s) => s.text)).toEqual([
      "kept, edited",
      "fresh tail",
    ]);
    expect(result.applied).toHaveLength(3);
    expect(result.applied[0]?.id).toBe(keep.id);
    expect(result.applied[2]?.id).toBeTruthy(); // the minted slot
    expect(await readFile(path.join(root, "note.md"), "utf8")).toBe(
      "kept, edited\n\nfresh tail",
    );
  });

  it("history lists engine transactions and reconstructs as-of", async () => {
    await store.saveBody("note.md", [{ text: "v1" }]);
    await store.saveBody("note.md", [{ text: "v2" }]);
    const revs = await store.readRevisions("note.md");
    expect(revs.length).toBeGreaterThanOrEqual(2);
    const oldest = revs[revs.length - 1];
    if (oldest === undefined) throw new Error("no revisions");
    const at = await store.readRevisionAt("note.md", oldest.revision);
    expect(at.map((s) => s.text)).toEqual(["v1"]);
  });

  it("hasBody counts blocks per node, 0 for the absent", async () => {
    await store.saveBody("yes.md", [{ text: "x" }, { text: "y" }]);
    const counts = await store.hasBody(["yes.md", "no.md"]);
    expect(counts.get("yes.md")).toBe(2);
    expect(counts.get("no.md")).toBe(0);
  });

  it("scan ingests a pre-existing working tree (first run)", async () => {
    await writeFile(path.join(root, "seeded.md"), "was here first", "utf8");
    await store.scan();
    const body = await store.readBody("seeded.md");
    expect(body.map((s) => s.text)).toEqual(["was here first"]);
  });

  it("refuses escaping and non-markdown paths", async () => {
    await expect(store.readBody("../escape.md")).rejects.toThrow(
      /invalid_path/,
    );
    await expect(store.readBody("binary.png")).rejects.toThrow(
      /unsupported_file/,
    );
    await expect(store.readBody("")).rejects.toThrow(/invalid_path/);
  });

  it("tags: the computed walk over the working tree", async () => {
    await store.saveBody("a.md", [{ text: "hello #focus" }]);
    await store.saveBody("sub/b.md", [{ text: "#focus #calm" }]);
    const tags = await store.listTags();
    expect(tags.tags).toContainEqual({ tag: "#focus", count: 2 });
    const calm = await store.listByTag("calm");
    expect(calm.node_ids).toEqual(["sub/b.md"]);
  });
});

describe("extractWikilinks", () => {
  it("lowercased basenames, aliases and headings stripped", () => {
    expect(
      extractWikilinks("see [[Brain Soup/Idea]] and [[Other|alias]] [[X#h]]"),
    ).toEqual(["idea", "other", "x"]);
  });
});
