/**
 * F6 — the note-native dissolve sink, over the fixture dials: identity keyed
 * by source_path, one-block CoW generations, provenance-as-attributes, and
 * idempotence at every layer.
 */

import { describe, expect, it } from "vitest";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { FixtureTagStore } from "../src/tag-store.js";
import { sinkNoteVersion, NotesSinkError } from "../src/notes-sink.js";
import { sha256 } from "../src/document-store.js";

const SCOPE = "notes";

function rig() {
  return {
    client: new FixtureBodyClient(),
    dial: new FixtureChaosDial(),
    tags: new FixtureTagStore(),
  };
}

describe("sinkNoteVersion (F6)", () => {
  it("mints a note keyed by source_path with a one-block body and provenance attrs", async () => {
    const { client, dial, tags } = rig();
    const res = await sinkNoteVersion(client, dial, SCOPE, tags, {
      source_path: "Brain Soup/Idea.md",
      body_text: "# Idea\n\nprose #brain-soup",
      subject: "Idea",
      schema_type: "DigitalDocument",
      source_kind: "vault-note",
      mtime: "2026-07-01T00:00:00Z",
    });
    expect(res.created).toBe(true);
    expect(res.generation).toBe("minted");

    // One-block container, byte-identical body.
    const body = await client.readBody(res.node_id);
    expect(body).toHaveLength(1);
    expect(body[0]?.text).toBe("# Idea\n\nprose #brain-soup");

    // Identity: the graph name IS the source_path.
    expect(await dial.findByName("Note", "Brain Soup/Idea.md")).toEqual([
      res.node_id,
    ]);

    // Provenance attributes on the note.
    const edges = await dial.edges(res.node_id);
    const attr = (p: string) =>
      edges.find((e) => e.predicate === p && !e.isNode)?.value;
    expect(attr("source_path")).toBe("Brain Soup/Idea.md");
    expect(attr("raw_hash")).toBe(sha256("# Idea\n\nprose #brain-soup"));
    expect(attr("source_kind")).toBe("vault-note");
    expect(attr("mtime")).toBe("2026-07-01T00:00:00Z");
    expect(attr("title")).toBe("Idea");
    expect(attr("schema_type")).toBe("DigitalDocument");
    // Absent columns → absent attributes.
    expect(attr("ctime")).toBeUndefined();
    expect(attr("file_path")).toBeUndefined();

    // Inline tags became real tag edges (like any other note).
    expect(attr("hasTag")).toBe("#brain-soup");
  });

  it("a new version supersedes as a CoW generation; identical body no-ops", async () => {
    const { client, dial, tags } = rig();
    const v1 = await sinkNoteVersion(client, dial, SCOPE, tags, {
      source_path: "Notes/n.md",
      body_text: "v1",
    });
    const v2 = await sinkNoteVersion(client, dial, SCOPE, tags, {
      source_path: "Notes/n.md",
      body_text: "v2",
    });
    expect(v2.node_id).toBe(v1.node_id); // reuse, not a twin
    expect(v2.created).toBe(false);
    expect(v2.generation).toBe("superseded");
    // As-of reconstruction serves each version.
    const revs = await client.readRevisions(v1.node_id);
    expect(revs).toHaveLength(2);
    const [newest, oldest] = revs;
    if (!newest || !oldest) throw new Error("missing revisions");
    expect(
      (await client.readRevisionAt(v1.node_id, oldest.revision)).map(
        (s) => s.text,
      ),
    ).toEqual(["v1"]);
    expect(
      (await client.readRevisionAt(v1.node_id, newest.revision)).map(
        (s) => s.text,
      ),
    ).toEqual(["v2"]);
    // raw_hash attr reconciled to the newest — old literal retracted.
    const hashes = (await dial.edges(v1.node_id)).filter(
      (e) => e.predicate === "raw_hash",
    );
    expect(hashes).toHaveLength(1);
    expect(hashes[0]?.value).toBe(sha256("v2"));

    // Identical re-submit: zero deltas everywhere.
    const eventsBefore = (await client.readRevisions(v1.node_id)).length;
    const admitsBefore = dial.admits.length;
    const v3 = await sinkNoteVersion(client, dial, SCOPE, tags, {
      source_path: "Notes/n.md",
      body_text: "v2",
    });
    expect(v3.generation).toBe("nooped");
    expect((await client.readRevisions(v1.node_id)).length).toBe(eventsBefore);
    expect(dial.admits.length).toBe(admitsBefore); // no attr ops, no tag ops
  });

  it("a refused admit surfaces as a NotesSinkError with violations", async () => {
    const { client, dial, tags } = rig();
    dial.refuseWith = [{ rule: "nope" }];
    await expect(
      sinkNoteVersion(client, dial, SCOPE, tags, {
        source_path: "Notes/refused.md",
        body_text: "x",
      }),
    ).rejects.toThrow(NotesSinkError);
  });

  it("title collisions cannot collapse identities — paths are the key", async () => {
    const { client, dial, tags } = rig();
    const a = await sinkNoteVersion(client, dial, SCOPE, tags, {
      source_path: "A/Untitled.md",
      body_text: "a",
      subject: "Untitled",
    });
    const b = await sinkNoteVersion(client, dial, SCOPE, tags, {
      source_path: "B/Untitled.md",
      body_text: "b",
      subject: "Untitled",
    });
    expect(a.node_id).not.toBe(b.node_id);
  });
});
