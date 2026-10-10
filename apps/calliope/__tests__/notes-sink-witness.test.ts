/**
 * What notes-sink hands the converge witness, pinned exactly: the ops the
 * legacy path SENT (the mint batch's attribute ops on a create, the one
 * reconcile batch on an update), the held snapshot read before the write, and
 * the refusal path of the single attribute admit.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Observation } from "../src/converge-witness.js";

const seen: Observation[] = [];
vi.mock("../src/converge-witness.js", async (orig) => ({
  ...(await orig<typeof import("../src/converge-witness.js")>()),
  observe: (o: Observation) => {
    seen.push(o);
  },
}));

const { sha256 } = await import("../src/document-store.js");
const { FixtureBodyClient } = await import("../src/fixture-client.js");
const { FixtureChaosDial } = await import("../src/chaos-client.js");
const { FixtureTagStore } = await import("../src/tag-store.js");
const { dissolveContainer, NotesSinkError, sinkNoteVersion } =
  await import("../src/notes-sink.js");

const SCOPE = "notes";

function rig() {
  return {
    client: new FixtureBodyClient(),
    dial: new FixtureChaosDial(),
    tags: new FixtureTagStore(),
  };
}

beforeEach(() => {
  seen.length = 0;
});

describe("the witness sees what legacy sent", () => {
  it("a create: the attribute ops that rode the mint batch, nothing held", async () => {
    const { client, dial, tags } = rig();
    await sinkNoteVersion(
      client,
      dial,
      SCOPE,
      tags,
      { source_path: "W/a.md", body_text: "x", raw_hash: "h1" },
      undefined,
      { additiveAttrs: [["document_id", "d1"]] },
    );
    const mint = dial.admits.find((a) =>
      a.ops.some((o) => o.op === "createNode" && o.label === "W/a.md"),
    );
    const sent = (mint?.ops ?? [])
      .filter((o) => o.op === "addEdge" && o.from_id === "W/a.md")
      .filter(
        (o) => !["hasName", "hasType", "parent"].includes(String(o.predicate)),
      )
      .map((o) => [o.predicate, o.to_literal]);
    expect(sent).toEqual([
      ["source_path", "W/a.md"],
      ["raw_hash", "h1"],
      ["source_kind", "vault-note"],
      ["schema_type", "DigitalDocument"],
      ["document_id", "d1"],
    ]);
    expect(seen).toHaveLength(1);
    const o = seen[0];
    expect(o?.name).toBe("W/a.md");
    expect(o?.scope).toBe(SCOPE);
    expect(o?.holders).toEqual([]);
    expect(o?.held).toEqual([]);
    expect(o?.legacyOutcome).toBe("created");
    expect(o?.legacyOps).toEqual(
      sent.map(([p, v]) => ({ kind: "add", p, o: v, node: false })),
    );
    expect([...(o?.one ?? [])]).toEqual([
      ["source_path", "W/a.md"],
      ["raw_hash", "h1"],
      ["source_kind", "vault-note"],
      ["schema_type", "DigitalDocument"],
    ]);
    expect(o?.additive).toEqual([["document_id", "d1"]]);
  });

  it("an update: the one reconcile batch, with the held snapshot from before it", async () => {
    const { client, dial, tags } = rig();
    const first = await sinkNoteVersion(client, dial, SCOPE, tags, {
      source_path: "W/b.md",
      body_text: "v1",
    });
    seen.length = 0;
    await sinkNoteVersion(
      client,
      dial,
      SCOPE,
      tags,
      { source_path: "W/b.md", body_text: "v2" },
      undefined,
      { additiveAttrs: [["document_id", "d2"]] },
    );
    const o = seen[0];
    expect(seen).toHaveLength(1);
    expect(o?.holders).toEqual([first.node_id]);
    expect(o?.legacyOutcome).toBe("updated");
    expect(o?.held.find((e) => e.predicate === "raw_hash")?.isNode).toBe(false);
    expect(o?.held.some((e) => e.predicate === "document_id")).toBe(false);
    expect(o?.legacyOps).toEqual([
      { kind: "retract", p: "raw_hash", o: sha256("v1"), node: false },
      { kind: "add", p: "raw_hash", o: sha256("v2"), node: false },
      { kind: "add", p: "document_id", o: "d2", node: false },
    ]);
  });

  it("a no-op: unchanged, no admit, no ops", async () => {
    const { client, dial, tags } = rig();
    const input = { source_path: "W/c.md", body_text: "same" };
    await sinkNoteVersion(client, dial, SCOPE, tags, input);
    seen.length = 0;
    const admits = dial.admits.length;
    await sinkNoteVersion(client, dial, SCOPE, tags, input);
    expect(dial.admits.length).toBe(admits);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.legacyOutcome).toBe("unchanged");
    expect(seen[0]?.legacyOps).toEqual([]);
  });

  it("dissolveContainer asserts no additive pairs", async () => {
    const { client, dial, tags } = rig();
    await dissolveContainer(client, dial, SCOPE, tags, {
      source_path: "W/d.md",
      blocks: ["a", "b"],
    });
    expect(seen[0]?.additive).toEqual([]);
  });

  it("a refused attribute batch on an existing note is a NotesSinkError, and is not witnessed", async () => {
    const { client, dial, tags } = rig();
    const first = await sinkNoteVersion(client, dial, SCOPE, tags, {
      source_path: "W/e.md",
      body_text: "v1",
    });
    seen.length = 0;
    dial.refuseWith = [{ rule: "no" }];
    const err = await sinkNoteVersion(client, dial, SCOPE, tags, {
      source_path: "W/e.md",
      body_text: "v2",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotesSinkError);
    expect((err as Error).message).toBe(
      `notes-sink: the gate refused the attribute batch for ${first.node_id}`,
    );
    expect((err as InstanceType<typeof NotesSinkError>).violations).toEqual([
      { rule: "no" },
    ]);
    expect(seen).toHaveLength(0);
  });
});

describe("additive asserts", () => {
  it("assert each missing pair once, skip standing pairs, never retract", async () => {
    const { client, dial, tags } = rig();
    await sinkNoteVersion(
      client,
      dial,
      SCOPE,
      tags,
      { source_path: "W/f.md", body_text: "x" },
      undefined,
      { additiveAttrs: [["document_id", "d1"]] },
    );
    const before = dial.admits.length;
    await sinkNoteVersion(
      client,
      dial,
      SCOPE,
      tags,
      { source_path: "W/f.md", body_text: "x" },
      undefined,
      {
        additiveAttrs: [
          ["document_id", "d1"],
          ["document_id", "d2"],
          ["document_id", "d2"],
          ["other", "d1"],
        ],
      },
    );
    expect(dial.admits.length - before).toBe(1);
    const ops = dial.admits.at(-1)?.ops ?? [];
    expect(ops.map((o) => [o.op, o.predicate, o.to_literal])).toEqual([
      ["addEdge", "document_id", "d2"],
      ["addEdge", "other", "d1"],
    ]);
  });
});
