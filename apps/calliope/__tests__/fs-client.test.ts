import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsBodyClient } from "../src/fs-client.js";
import { between } from "../src/order-key.js";
import type { SectionOp } from "../src/types.js";

let root: string;
let client: FsBodyClient;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fs-client-"));
  client = new FsBodyClient(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

async function disk(rel: string): Promise<string> {
  return readFile(path.join(root, rel), "utf8");
}

describe("FsBodyClient.readBody — derivation", () => {
  it("derives blank-line-split sections with one generation id", async () => {
    await seed("note.md", "alpha\n\nbeta\n\ngamma");
    const sections = await client.readBody("note.md");
    expect(sections.map((s) => s.text)).toEqual(["alpha", "beta", "gamma"]);
    const generations = new Set(sections.map((s) => s.id.split(":")[0]));
    expect(generations.size).toBe(1);
    const keys = sections.map((s) => s.orderKey);
    expect([...keys].sort()).toEqual(keys);
  });

  it("a missing file is an empty body", async () => {
    expect(await client.readBody("absent.md")).toEqual([]);
  });

  it("an empty file is an empty body", async () => {
    await seed("empty.md", "");
    expect(await client.readBody("empty.md")).toEqual([]);
  });

  it("a CRLF file has no boundary and reads coarse", async () => {
    await seed("crlf.md", "alpha\r\n\r\nbeta\r\n");
    const sections = await client.readBody("crlf.md");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toBe("alpha\r\n\r\nbeta\r\n");
  });

  it("subdirectory paths resolve", async () => {
    await seed("sub/dir/note.md", "content");
    const sections = await client.readBody("sub/dir/note.md");
    expect(sections[0]?.text).toBe("content");
  });

  it("refuses traversal and non-markdown", async () => {
    await expect(client.readBody("../escape.md")).rejects.toThrow(
      /^invalid_path:/,
    );
    await expect(client.readBody("binary.png")).rejects.toThrow(
      /^unsupported_file:/,
    );
  });
});

describe("FsBodyClient round trips — byte identity", () => {
  const cases: [string, string][] = [
    ["lf multi-block", "alpha\n\nbeta\n\ngamma\n"],
    ["crlf", "alpha\r\n\r\nbeta\r\n"],
    ["no trailing newline", "alpha\n\nbeta"],
    ["multi-blank-line", "alpha\n\n\nbeta\n\n\n\ngamma"],
    ["leading blank lines", "\n\nalpha\n\n"],
  ];
  for (const [name, content] of cases) {
    it(`read → save is byte-identical (${name})`, async () => {
      await seed("note.md", content);
      const sections = await client.readBody("note.md");
      await client.saveBody(
        "note.md",
        sections.map((s) => ({ text: s.text })),
      );
      expect(await disk("note.md")).toBe(content);
    });
  }

  it("saveBody creates parent directories", async () => {
    await client.saveBody("fresh/new.md", [{ text: "born" }]);
    expect(await disk("fresh/new.md")).toBe("born");
  });
});

describe("FsBodyClient.editSection", () => {
  it("edits the addressed section in place", async () => {
    await seed("note.md", "alpha\n\nbeta");
    const [, second] = await client.readBody("note.md");
    if (second === undefined) throw new Error("expected two sections");
    const result = await client.editSection("note.md", second.id, "BETA");
    expect(result.text).toBe("BETA");
    expect(await disk("note.md")).toBe("alpha\n\nBETA");
  });

  it("rejects a stale section id and leaves the disk untouched", async () => {
    await seed("note.md", "alpha");
    const [first] = await client.readBody("note.md");
    if (first === undefined) throw new Error("expected a section");
    await seed("note.md", "mutated outside");
    await expect(
      client.editSection("note.md", first.id, "clobber"),
    ).rejects.toThrow(/^stale_section:/);
    expect(await disk("note.md")).toBe("mutated outside");
  });
});

describe("FsBodyClient.applySectionOps — the full algebra", () => {
  it("applies update/add/delete/reorder all-or-none and re-derives", async () => {
    await seed("note.md", "alpha\n\nbeta\n\ngamma");
    const sections = await client.readBody("note.md");
    const [a, b, c] = sections;
    if (a === undefined || b === undefined || c === undefined)
      throw new Error("expected three sections");
    const ops: SectionOp[] = [
      { op: "update", sectionId: a.id, text: "ALPHA" },
      {
        op: "add",
        text: "inserted",
        orderKey: between(a.orderKey, b.orderKey),
      },
      { op: "delete", sectionId: b.id },
      { op: "reorder", sectionId: c.id, orderKey: between(null, a.orderKey) },
    ];
    const result = await client.applySectionOps("note.md", ops);
    expect(result.sections.map((s) => s.text)).toEqual([
      "gamma",
      "ALPHA",
      "inserted",
    ]);
    // The derivation invariant: the result IS the next readBody.
    expect(await client.readBody("note.md")).toEqual(result.sections);
    expect(await disk("note.md")).toBe("gamma\n\nALPHA\n\ninserted");
  });

  it("any stale id rejects the whole batch, nothing written", async () => {
    await seed("note.md", "alpha\n\nbeta");
    const [a] = await client.readBody("note.md");
    if (a === undefined) throw new Error("expected a section");
    await seed("note.md", "changed\n\noutside");
    const ops: SectionOp[] = [{ op: "update", sectionId: a.id, text: "mine" }];
    await expect(client.applySectionOps("note.md", ops)).rejects.toThrow(
      /^stale_section:/,
    );
    expect(await disk("note.md")).toBe("changed\n\noutside");
  });

  it("duplicate section ids in one batch reject", async () => {
    await seed("note.md", "alpha");
    const [a] = await client.readBody("note.md");
    if (a === undefined) throw new Error("expected a section");
    const ops: SectionOp[] = [
      { op: "update", sectionId: a.id, text: "one" },
      { op: "delete", sectionId: a.id },
    ];
    await expect(client.applySectionOps("note.md", ops)).rejects.toThrow(
      /consumed earlier in the batch/,
    );
  });

  it("an update whose text re-splits keeps exact applied alignment", async () => {
    await seed("note.md", "alpha\n\nbeta");
    const [a, b] = await client.readBody("note.md");
    if (a === undefined || b === undefined)
      throw new Error("expected two sections");
    const result = await client.applySectionOps("note.md", [
      { op: "update", sectionId: a.id, text: "one\n\ntwo" },
    ]);
    expect(result.sections.map((s) => s.text)).toEqual(["one", "two", "beta"]);
    const applied = result.applied[0];
    expect(applied?.id).toBe(result.sections[0]?.id);
    expect(await client.readBody("note.md")).toEqual(result.sections);
  });

  it("add into an empty body creates the file", async () => {
    const result = await client.applySectionOps("new.md", [
      { op: "add", text: "first", orderKey: "m" },
    ]);
    expect(result.sections.map((s) => s.text)).toEqual(["first"]);
    expect(await disk("new.md")).toBe("first");
  });
});
