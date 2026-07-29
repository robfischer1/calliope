import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsBodyClient } from "../src/fs-client.js";

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

describe("FsBodyClient.readBody — derivation (the user grain)", () => {
  it("a file derives as exactly ONE section — blank lines never chunk", async () => {
    await seed("note.md", "alpha\n\nbeta\n\ngamma");
    const sections = await client.readBody("note.md");
    expect(sections.map((s) => s.text)).toEqual(["alpha\n\nbeta\n\ngamma"]);
    expect(sections).toHaveLength(1);
  });

  it("headings stay with their prose — one section, whatever the structure", async () => {
    await seed("note.md", "# Title\n\nintro\n\n## Big Idea\n\nthe prose");
    const sections = await client.readBody("note.md");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toBe(
      "# Title\n\nintro\n\n## Big Idea\n\nthe prose",
    );
  });

  it("a missing file is an empty body", async () => {
    expect(await client.readBody("absent.md")).toEqual([]);
  });

  it("an empty file is an empty body", async () => {
    await seed("empty.md", "");
    expect(await client.readBody("empty.md")).toEqual([]);
  });

  it("a CRLF file normalizes to LF like its LF twin", async () => {
    await seed("crlf.md", "alpha\r\n\r\nbeta\r\n");
    const sections = await client.readBody("crlf.md");
    expect(sections.map((s) => s.text)).toEqual(["alpha\n\nbeta\n"]);
  });

  it("lone-CR endings normalize the same way (markdown-it parity)", async () => {
    await seed("cr.md", "alpha\r\rbeta");
    const sections = await client.readBody("cr.md");
    expect(sections.map((s) => s.text)).toEqual(["alpha\n\nbeta"]);
  });

  it("the generation id churns on ANY external rewrite", async () => {
    await seed("note.md", "alpha");
    const [before] = await client.readBody("note.md");
    await seed("note.md", "alpha!");
    const [after] = await client.readBody("note.md");
    expect(before?.id).toBeDefined();
    expect(after?.id).toBeDefined();
    expect(after?.id).not.toBe(before?.id);
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

  it("applySectionOps is deliberately absent — the capability must not advertise", () => {
    expect(
      (client as unknown as Record<string, unknown>).applySectionOps,
    ).toBeUndefined();
  });
});

describe("FsBodyClient round trips — byte identity", () => {
  const cases: [string, string][] = [
    ["lf multi-block", "alpha\n\nbeta\n\ngamma\n"],
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

  it("a CRLF file's read → save lands as LF (the dialect flip)", async () => {
    await seed("note.md", "alpha\r\n\r\nbeta\r\n");
    const sections = await client.readBody("note.md");
    await client.saveBody(
      "note.md",
      sections.map((s) => ({ text: s.text })),
    );
    expect(await disk("note.md")).toBe("alpha\n\nbeta\n");
  });

  it("a multi-block save joins with the block separator (the editor's split)", async () => {
    await client.saveBody("note.md", [{ text: "alpha" }, { text: "beta" }]);
    expect(await disk("note.md")).toBe("alpha\n\nbeta");
    // ...and reads back as ONE section: file splits are not durable grain.
    const sections = await client.readBody("note.md");
    expect(sections.map((s) => s.text)).toEqual(["alpha\n\nbeta"]);
  });

  it("saveBody creates parent directories", async () => {
    await client.saveBody("fresh/new.md", [{ text: "born" }]);
    expect(await disk("fresh/new.md")).toBe("born");
  });
});

describe("FsBodyClient.editSection", () => {
  it("edits THE section — the whole body — in place", async () => {
    await seed("note.md", "alpha\n\nbeta");
    const [only] = await client.readBody("note.md");
    if (only === undefined) throw new Error("expected one section");
    const result = await client.editSection(
      "note.md",
      only.id,
      "alpha\n\nBETA",
    );
    expect(result.text).toBe("alpha\n\nBETA");
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
