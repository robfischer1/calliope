import { describe, expect, it } from "vitest";
import { FixtureBodyClient } from "../src/fixture-client.js";
import {
  appendSection,
  editSection,
  readBody,
  writeBody,
} from "../src/mcp/tools.js";
import type { BodyClient } from "../src/types.js";

describe("calliope-mcp tools — over FixtureBodyClient", () => {
  it("read_body returns [] for an unknown node", async () => {
    const client = new FixtureBodyClient();
    expect(await readBody(client, "missing")).toEqual({ sections: [] });
  });

  it("read_body returns sections sorted by orderKey", async () => {
    const client = new FixtureBodyClient();
    await writeBody(client, "n1", [
      { text: "first" },
      { text: "second" },
      { text: "third" },
    ]);
    const result = await readBody(client, "n1");
    expect(result.sections.map((s) => s.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    const keys = result.sections.map((s) => s.orderKey);
    expect([...keys].sort()).toEqual(keys);
    for (const s of result.sections) {
      expect(typeof s.id).toBe("string");
      expect(s.id.length).toBeGreaterThan(0);
    }
  });

  it("write_body coarse-saves and reports { ok, count }", async () => {
    const client = new FixtureBodyClient();
    const res = await writeBody(client, "n1", [
      { text: "## Heading" },
      { text: "body" },
    ]);
    expect(res).toEqual({ ok: true, count: 2 });
    expect((await readBody(client, "n1")).sections.map((s) => s.text)).toEqual([
      "## Heading",
      "body",
    ]);
  });

  it("write_body replaces the whole body on re-save", async () => {
    const client = new FixtureBodyClient();
    await writeBody(client, "n1", [{ text: "old" }]);
    const res = await writeBody(client, "n1", [
      { text: "new1" },
      { text: "new2" },
    ]);
    expect(res.count).toBe(2);
    expect((await readBody(client, "n1")).sections.map((s) => s.text)).toEqual([
      "new1",
      "new2",
    ]);
  });

  it("append_section appends one section at the end", async () => {
    const client = new FixtureBodyClient();
    await writeBody(client, "n1", [{ text: "intro" }]);
    const res = await appendSection(client, "n1", "outro");
    expect(res.count).toBe(2);
    expect(res.section.text).toBe("outro");
    const body = await readBody(client, "n1");
    expect(body.sections.map((s) => s.text)).toEqual(["intro", "outro"]);
    // the returned section is the last (highest order key) one
    expect(res.section.id).toBe(body.sections.at(-1)?.id);
  });

  it("append_section works on an empty body", async () => {
    const client = new FixtureBodyClient();
    const res = await appendSection(client, "fresh", "only");
    expect(res.count).toBe(1);
    expect(res.section.text).toBe("only");
  });

  it("edit_section replaces one section, keeps order + others", async () => {
    const client = new FixtureBodyClient();
    await writeBody(client, "n1", [
      { text: "alpha" },
      { text: "beta" },
      { text: "gamma" },
    ]);
    const before = await readBody(client, "n1");
    const betaId = before.sections[1]?.id ?? "";
    const betaKey = before.sections[1]?.orderKey ?? "";
    expect(betaId).not.toBe("");

    const res = await editSection(client, "n1", betaId, "BETA!");
    expect(res.section.text).toBe("BETA!");
    // order key preserved (position unchanged)
    expect(res.section.orderKey).toBe(betaKey);

    const after = await readBody(client, "n1");
    expect(after.sections.map((s) => s.text)).toEqual([
      "alpha",
      "BETA!",
      "gamma",
    ]);
    // the other sections kept their identity
    expect(after.sections[0]?.id).toBe(before.sections[0]?.id);
    expect(after.sections[2]?.id).toBe(before.sections[2]?.id);
  });

  it("edit_section rejects an unknown section id", async () => {
    const client = new FixtureBodyClient();
    await writeBody(client, "n1", [{ text: "x" }]);
    await expect(editSection(client, "n1", "nope", "y")).rejects.toThrow(
      /not part of/i,
    );
  });

  it("edit_section errors clearly when the backend lacks editSection", async () => {
    // A minimal BodyClient that predates the optional editSection method.
    const legacy: BodyClient = {
      readBody: () => Promise.resolve([]),
      saveBody: () => Promise.resolve(),
    };
    await expect(editSection(legacy, "n1", "s1", "y")).rejects.toThrow(
      /does not support/i,
    );
  });
});
