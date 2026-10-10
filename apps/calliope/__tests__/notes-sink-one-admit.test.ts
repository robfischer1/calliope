/**
 * F9 one-logical-write-one-batch (calliope#16182): a note create or promote
 * carries its attributes on the `{"$mint":0}` batch, so a new note is born
 * whole; an existing note's attribute reconcile and additive assert ride ONE
 * admit. The body write stays the declared carve-out (its own store).
 */

import { describe, expect, it } from "vitest";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { FixtureTagStore } from "../src/tag-store.js";
import { sinkNoteVersion } from "../src/notes-sink.js";
import { createNote, isCreateNoteError } from "../src/mcp/tools.js";

const SCOPE = "notes";

describe("createNote carries attrs on the mint", () => {
  it("a new note is born whole: attrs ride the createNode batch", async () => {
    const dial = new FixtureChaosDial();
    const res = await createNote(dial, SCOPE, {
      title: "Born/Whole.md",
      attrs: new Map([["source_path", "Born/Whole.md"]]),
    });
    if (isCreateNoteError(res)) throw new Error(res.detail);
    expect(res.created).toBe(true);
    const mints = dial.admits.filter((a) =>
      a.ops.some((o) => o.op === "createNode" && o.label === "Born/Whole.md"),
    );
    expect(mints).toHaveLength(1);
    const attr = (await dial.edges(res.node_id)).find(
      (e) => e.predicate === "source_path",
    );
    expect(attr?.value).toBe("Born/Whole.md");
    // The mint batch itself holds the attribute (not a later admit).
    expect(
      mints[0]?.ops.some(
        (o) => o.op === "addEdge" && o.predicate === "source_path",
      ),
    ).toBe(true);
  });
});

describe("sinkNoteVersion admits (one logical write)", () => {
  it("a new note lands in ONE graph admit (mint + provenance + additive)", async () => {
    const client = new FixtureBodyClient();
    const dial = new FixtureChaosDial();
    const tags = new FixtureTagStore();
    await sinkNoteVersion(
      client,
      dial,
      SCOPE,
      tags,
      { source_path: "One/Admit.md", body_text: "plain prose" },
      undefined,
      { additiveAttrs: [["document_id", "doc-1"]] },
    );
    // The ensured Notes root is its own admit; the note's is one.
    const noteAdmits = dial.admits.filter((a) =>
      a.ops.some((o) => o.op === "addEdge" && o.from_id === "One/Admit.md"),
    );
    expect(noteAdmits).toHaveLength(1);
    expect(dial.admits.at(-1)).toBe(noteAdmits[0]);
  });

  it("an existing note's reconcile + additive assert are ONE admit", async () => {
    const client = new FixtureBodyClient();
    const dial = new FixtureChaosDial();
    const tags = new FixtureTagStore();
    const first = await sinkNoteVersion(client, dial, SCOPE, tags, {
      source_path: "One/Again.md",
      body_text: "v1",
    });
    const before = dial.admits.length;
    await sinkNoteVersion(
      client,
      dial,
      SCOPE,
      tags,
      { source_path: "One/Again.md", body_text: "v2" },
      undefined,
      { additiveAttrs: [["document_id", "doc-2"]] },
    );
    expect(dial.admits.length - before).toBe(1);
    const edges = await dial.edges(first.node_id);
    expect(edges.find((e) => e.predicate === "raw_hash")?.value).not.toBe(
      undefined,
    );
    expect(
      edges.some((e) => e.predicate === "document_id" && e.value === "doc-2"),
    ).toBe(true);
  });
});
