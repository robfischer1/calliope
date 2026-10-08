/**
 * create_note's `type` — the hasType edge a caller names (a mnemosyne body
 * is "Memory"), while the node's kind stays Note so `(Note, title)` keeps
 * reusing the one node. Everything note-only keys off hasType=Note, so a
 * Memory-typed body falls out of the tag path, set_properties, and the
 * notes listing.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { createServer } from "../src/mcp/server.js";
import {
  createNote,
  isCreateNoteError,
  maybeReconcileInlineTags,
} from "../src/mcp/tools.js";
import { setProperties } from "../src/properties.js";
import { FixtureTagStore } from "../src/tag-store.js";

const SCOPE = "notes";

async function mint(dial: FixtureChaosDial, title: string, type?: string) {
  const res = await createNote(dial, SCOPE, {
    title,
    ...(type !== undefined ? { type } : {}),
  });
  if (isCreateNoteError(res)) throw new Error(res.detail);
  return res;
}

function typesOf(edges: { predicate: string; value: string }[]): string[] {
  return edges.filter((e) => e.predicate === "hasType").map((e) => e.value);
}

describe("create_note type", () => {
  it("defaults the hasType edge to Note", async () => {
    const dial = new FixtureChaosDial();
    const { node_id } = await mint(dial, "Plain");
    expect(typesOf(await dial.edges(node_id))).toEqual(["Note"]);
  });

  it("writes the named type on the edge and keeps the kind Note", async () => {
    const dial = new FixtureChaosDial();
    const { node_id, created } = await mint(dial, "memory:m:x", "Memory");
    expect(created).toBe(true);
    expect(typesOf(await dial.edges(node_id))).toEqual(["Memory"]);
    // The mint's createNode carries kind Note: the reuse key finds it.
    const mintOp = dial.admits
      .flatMap((a) => a.ops)
      .find((o) => o.op === "createNode" && o.label === "memory:m:x");
    expect(mintOp?.kind).toBe("Note");
    expect(await dial.findByName("Note", "memory:m:x")).toEqual([node_id]);
  });

  it("a re-run reuses the one node — no twin, no new admits", async () => {
    const dial = new FixtureChaosDial();
    const first = await mint(dial, "memory:m:y", "Memory");
    const before = dial.admits.length;
    const again = await mint(dial, "memory:m:y", "Memory");
    expect(again).toEqual({ node_id: first.node_id, created: false });
    expect(dial.admits.length).toBe(before);
  });

  it("the heal path re-asserts the named type", async () => {
    const dial = new FixtureChaosDial();
    const orphan = "ef".repeat(32);
    dial.seed("Note", "memory:m:z", orphan);
    await mint(dial, "memory:m:z", "Memory");
    expect(typesOf(await dial.edges(orphan))).toEqual(["Memory"]);
  });
});

describe("a Memory-typed node is not a note", () => {
  it("the inline-tag reconcile skips it", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const { node_id } = await mint(dial, "memory:m:t", "Memory");
    const client = new FixtureBodyClient({
      [node_id]: [{ text: "has #inline tags" }],
    });
    expect(
      await maybeReconcileInlineTags(client, dial, SCOPE, store, node_id),
    ).toBeUndefined();
    expect(await store.byNode(node_id)).toEqual([]);
  });

  it("set_properties refuses it as not_a_note", async () => {
    const dial = new FixtureChaosDial();
    const { node_id } = await mint(dial, "memory:m:p", "Memory");
    const res = await setProperties(dial, SCOPE, undefined, {
      container_id: node_id,
      properties: [],
    });
    expect(res).toMatchObject({ code: "not_a_note" });
  });

  it("the hasType=Note extent (the notes listing) leaves it out", async () => {
    const dial = new FixtureChaosDial();
    const note = await mint(dial, "A note");
    const memory = await mint(dial, "memory:m:l", "Memory");
    const extent = await dial.findByValue(SCOPE, "hasType", "Note");
    expect(extent).toContain(note.node_id);
    expect(extent).not.toContain(memory.node_id);
  });
});

describe("the create_note verb's type", () => {
  async function rig() {
    const dial = new FixtureChaosDial();
    const tags = new FixtureTagStore();
    const server = createServer(new FixtureBodyClient(), {
      chaos: { dial, scope: SCOPE },
      containers: { blobs: new FixtureBlobStore(), dial },
      tags,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(st), mcp.connect(ct)]);
    return { mcp, dial, tags };
  }

  it("passes type through, and a body save on it runs no tag path", async () => {
    const { mcp, dial, tags } = await rig();
    const res = await mcp.callTool({
      name: "create_note",
      arguments: { title: "memory:mnemosyne:v", type: "Memory" },
    });
    expect(res.isError).toBeFalsy();
    const node = (res.structuredContent as { node_id: string }).node_id;
    expect(typesOf(await dial.edges(node))).toEqual(["Memory"]);
    const saved = await mcp.callTool({
      name: "write_container",
      arguments: {
        container: node,
        ops: [{ op: "add", text: "prose with #tag", position: "a0" }],
      },
    });
    expect(saved.isError).toBeFalsy();
    const out = saved.structuredContent as { tags?: unknown };
    expect(out.tags).toBeUndefined();
    expect(await tags.byNode(node)).toEqual([]);
  });

  it("an absent type mints hasType Note", async () => {
    const { mcp, dial } = await rig();
    const res = await mcp.callTool({
      name: "create_note",
      arguments: { title: "plain" },
    });
    const node = (res.structuredContent as { node_id: string }).node_id;
    expect(typesOf(await dial.edges(node))).toEqual(["Note"]);
  });

  it("refuses a type that is not a bare identifier at the schema", async () => {
    const { mcp } = await rig();
    for (const type of ["", "has space", "1Memory", "Memory!"]) {
      const res = await mcp.callTool({
        name: "create_note",
        arguments: { title: "t", type },
      });
      expect(res.isError, type).toBe(true);
      expect(res.structuredContent, type).toBeUndefined();
    }
  });

  it("publishes type as an optional one-line argument", async () => {
    const { mcp } = await rig();
    const { tools } = await mcp.listTools();
    const tool = tools.find((t) => t.name === "create_note");
    const schema = tool?.inputSchema as {
      properties: Record<string, { description?: string; default?: string }>;
      required?: string[];
    };
    expect(schema.required).toEqual(["title"]);
    expect(schema.properties.type).toMatchObject({
      default: "Note",
      description: "The hasType edge; the node kind stays Note.",
    });
  });
});
