/**
 * F7 — the notes-backed DocumentStore: the table's read contract served
 * from the merged store, writes as the sink alone.
 */

import { describe, expect, it } from "vitest";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { NotesDocumentStore } from "../src/notes-document-store.js";
import { assertAdditiveAttrs } from "../src/notes-sink.js";
import { sha256 } from "../src/document-store.js";

const SCOPE = "notes";

function rig(): {
  store: NotesDocumentStore;
  client: FixtureBodyClient;
  dial: FixtureChaosDial;
} {
  const client = new FixtureBodyClient();
  const dial = new FixtureChaosDial();
  return { store: new NotesDocumentStore(client, dial, SCOPE), client, dial };
}

describe("NotesDocumentStore (F7)", () => {
  it("write lands note-native only and dedups through the sink", async () => {
    const { store, client, dial } = rig();
    const res = await store.write({
      source_path: "Notes/fresh.md",
      body_text: "fresh body",
      subject: "Fresh",
    });
    expect(res.ok).toBe(true);
    expect(res.id).toBeNull(); // no table sequence — ids are migration-legacy
    expect(res.deduped).toBe(false);
    expect(res.note.generation).toBe("minted");
    const [node] = await dial.findByName("Note", "Notes/fresh.md");
    if (node === undefined) throw new Error("note missing");
    expect((await client.readBody(node)).map((s) => s.text)).toEqual([
      "fresh body",
    ]);
    // Identical retry dedups; changed body supersedes.
    const retry = await store.write({
      source_path: "Notes/fresh.md",
      body_text: "fresh body",
      subject: "Fresh",
    });
    expect(retry.deduped).toBe(true);
  });

  it("byId resolves migrated document_id handles; bySourcePath serves newest state", async () => {
    const { store, dial } = rig();
    await store.write({
      source_path: "Notes/handled.md",
      body_text: "v1",
      mtime: "2026-07-01T00:00:00Z",
    });
    const [node] = await dial.findByName("Note", "Notes/handled.md");
    if (node === undefined) throw new Error("note missing");
    // The migration's id bridge.
    await assertAdditiveAttrs(dial, SCOPE, node, [["document_id", "42"]]);

    const byId = await store.byId(42);
    expect(byId?.source_path).toBe("Notes/handled.md");
    expect(byId?.id).toBe(42);
    expect(byId?.body_text).toBe("v1");
    expect(byId?.content_hash).toBe(sha256("v1"));
    expect(await store.byId(999)).toBeNull();

    await store.write({ source_path: "Notes/handled.md", body_text: "v2" });
    const rows = await store.bySourcePath("Notes/handled.md");
    expect(rows).toHaveLength(1); // newest state, not one row per version
    expect(rows[0]?.body_text).toBe("v2");
  });

  it("bySourcePath finds archive notes by attribute when no name matches", async () => {
    const { store, client, dial } = rig();
    // Two composite-named archive notes sharing a truthful source_path attr
    // (the prelude's shape) — seed through the sink with identity override.
    const { sinkNoteVersion } = await import("../src/notes-sink.js");
    for (const [disc, body] of [
      ["a.pdf", "body a"],
      ["b.pdf", "body b"],
    ] as const) {
      await sinkNoteVersion(
        client,
        dial,
        SCOPE,
        undefined,
        {
          source_path: "F:\\Archive",
          body_text: body,
          file_path: disc,
          source_kind: "phdb-migration",
        },
        undefined,
        {
          identity: `F:\\Archive :: ${disc}`,
          extraAttrs: new Map([["isArchived", "true"]]),
        },
      );
    }
    const rows = await store.bySourcePath("F:\\Archive");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.file_path).sort()).toEqual(["a.pdf", "b.pdf"]);
  });

  it("list filters by schema_type and honors omit_body", async () => {
    const { store } = rig();
    await store.write({
      source_path: "Notes/ds.md",
      body_text: "data",
      schema_type: "Dataset",
    });
    await store.write({
      source_path: "Notes/doc.md",
      body_text: "prose",
    });
    const datasets = await store.list({ schema_type: "Dataset" });
    expect(datasets).toHaveLength(1);
    expect(datasets[0]?.source_path).toBe("Notes/ds.md");
    const all = await store.list({ omit_body: true });
    expect(all.length).toBe(2);
    expect(all.every((r) => r.body_text === "")).toBe(true);
    expect(await store.listSourcePaths()).toEqual([
      "Notes/doc.md",
      "Notes/ds.md",
    ]);
  });
});
