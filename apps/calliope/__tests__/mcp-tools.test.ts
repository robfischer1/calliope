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

// ── C8: create_note over the FixtureChaosDial ────────────────────────────────

import {
  FixtureChaosDial,
  NOTE_ROOT_KIND,
  NOTE_ROOT_LABEL,
} from "../src/chaos-client.js";
import { createNote, isCreateNoteError } from "../src/mcp/tools.js";

const SCOPE = "notes";

describe("create_note — the note-native mint (C8)", () => {
  it("mints via two admits: createNode, then hasName/hasType/parent", async () => {
    const dial = new FixtureChaosDial();
    const result = await createNote(dial, SCOPE, { title: "My Note" });
    expect(isCreateNoteError(result)).toBe(false);
    if (isCreateNoteError(result)) return;
    expect(result.created).toBe(true);
    // admits: root mint (2: create+edges) then the note mint (2: create+edges)
    expect(dial.admits).toHaveLength(4);
    const noteEdges = dial.admits[3];
    expect(noteEdges?.ops.map((o) => o.predicate)).toEqual([
      "hasName",
      "hasType",
      "parent",
    ]);
    const parentOp = noteEdges?.ops[2];
    const root = await dial.findByName(NOTE_ROOT_KIND, NOTE_ROOT_LABEL);
    expect(parentOp?.to_node).toBe(root[0]);
    expect(noteEdges?.scope).toBe(SCOPE);
  });

  it("is idempotent: an identical re-run answers the standing node, no new admits", async () => {
    const dial = new FixtureChaosDial();
    const first = await createNote(dial, SCOPE, { title: "Twice" });
    if (isCreateNoteError(first)) throw new Error("first create failed");
    const before = dial.admits.length;
    const second = await createNote(dial, SCOPE, { title: "Twice" });
    if (isCreateNoteError(second)) throw new Error("second create failed");
    expect(second.node_id).toBe(first.node_id);
    expect(second.created).toBe(false);
    expect(dial.admits.length).toBe(before); // heal check read only, no writes
  });

  it("heals an interrupted mint: a dictionary row without edges gets them", async () => {
    const dial = new FixtureChaosDial();
    const orphan = "cd".repeat(32);
    dial.seed("Note", "Broken", orphan); // row exists, edges never landed
    const result = await createNote(dial, SCOPE, { title: "Broken" });
    if (isCreateNoteError(result)) throw new Error("heal path errored");
    expect(result.node_id).toBe(orphan);
    expect(result.created).toBe(false);
    const healed = await dial.edges(orphan);
    expect(healed.map((e) => e.predicate)).toEqual([
      "hasName",
      "hasType",
      "parent",
    ]);
  });

  it("honors a caller parent that exists on the dictionary", async () => {
    const dial = new FixtureChaosDial();
    const parent = "ef".repeat(32);
    dial.seed("Note", "The Parent", parent);
    const result = await createNote(dial, SCOPE, {
      title: "Child",
      parent,
    });
    if (isCreateNoteError(result)) throw new Error("create failed");
    const edges = await dial.edges(result.node_id);
    expect(edges.find((e) => e.predicate === "parent")?.value).toBe(parent);
    // no root ensure ran: only the note's own two admits
    expect(dial.admits).toHaveLength(2);
  });

  it("rejects a malformed and an unknown parent as bad_parent", async () => {
    const dial = new FixtureChaosDial();
    const malformed = await createNote(dial, SCOPE, {
      title: "X",
      parent: "not-hex",
    });
    expect(isCreateNoteError(malformed) && malformed.error).toBe("bad_parent");
    const unknown = await createNote(dial, SCOPE, {
      title: "X",
      parent: "aa".repeat(32),
    });
    expect(isCreateNoteError(unknown) && unknown.error).toBe("bad_parent");
  });

  it("rejects an empty title and empty tags", async () => {
    const dial = new FixtureChaosDial();
    const t = await createNote(dial, SCOPE, { title: "   " });
    expect(isCreateNoteError(t) && t.error).toBe("bad_title");
    const g = await createNote(dial, SCOPE, { title: "ok", tags: ["a", " "] });
    expect(isCreateNoteError(g) && g.error).toBe("bad_tags");
  });

  it("surfaces a gate refusal with its violations, verbatim", async () => {
    const dial = new FixtureChaosDial();
    dial.refuseWith = [{ shape: "Note", missing: ["hasName"] }];
    const result = await createNote(dial, SCOPE, { title: "Refused" });
    expect(isCreateNoteError(result)).toBe(true);
    if (!isCreateNoteError(result)) return;
    expect(result.error).toBe("admit_refused");
    expect(result.violations).toEqual([
      { shape: "Note", missing: ["hasName"] },
    ]);
  });
});
