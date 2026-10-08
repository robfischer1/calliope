/**
 * A container save reconciles the note's inline tags.
 *
 * The removed body verbs (write_body / apply_section_ops) ran the C9
 * inline-tag reconcile after every write; write_container never did. Aglaia
 * saves through write_container (081 F9), so a `#tag` typed or deleted in
 * the editor never reached the note's hasTag edges or the note_tags mirror.
 * These pin every branch of the restored hook: add, retract, explicit rows
 * untouched, code never tags, and the cases where the hook must stay out
 * (noop, other tenants, non-notes, archived notes, no tag facet), plus a
 * reconcile failure that leaves the save standing. The body client THROWS
 * on every call, so each pass here proves the reconcile reads the tree.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial, opAdd, opCreate } from "../src/chaos-client.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { createServer } from "../src/mcp/server.js";
import { FixtureTagStore } from "../src/tag-store.js";

class DroppedTableClient extends FixtureBodyClient {
  override readBody(): Promise<never> {
    return Promise.reject(new Error('relation "sections" does not exist'));
  }
  override saveBody(): Promise<never> {
    return Promise.reject(new Error('relation "sections" does not exist'));
  }
}

interface Rig {
  mcp: Client;
  dial: FixtureChaosDial;
  tags: FixtureTagStore;
}

async function rig(
  opts: { tags?: boolean; chaos?: boolean } = {},
): Promise<Rig> {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const tags = new FixtureTagStore();
  const server = createServer(new DroppedTableClient(), {
    ...(opts.chaos === false ? {} : { chaos: { dial, scope: "notes" } }),
    containers: { blobs, dial },
    ...(opts.tags === false ? {} : { tags }),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return { mcp, dial, tags };
}

async function note(mcp: Client, title: string, tags?: string[]) {
  const res = await mcp.callTool({
    name: "create_note",
    arguments: { title, ...(tags !== undefined ? { tags } : {}) },
  });
  expect(res.isError).toBeFalsy();
  return (res.structuredContent as { node_id: string }).node_id;
}

interface Out {
  noop?: boolean;
  tags?: { added: string[]; removed: string[] };
  tags_error?: string;
}

async function add(
  mcp: Client,
  container: string,
  text: string,
  tenant?: string,
) {
  const res = await mcp.callTool({
    name: "write_container",
    arguments: {
      container,
      ops: [{ op: "add", text, position: "a0" }],
      ...(tenant !== undefined ? { tenant } : {}),
    },
  });
  expect(res.isError).toBeFalsy();
  return res.structuredContent as Out;
}

async function block(mcp: Client, container: string) {
  const res = await mcp.callTool({
    name: "read_container",
    arguments: { container },
  });
  const b = (
    res.structuredContent as {
      blocks: { slot: string; blobId: string; position: string }[];
    }
  ).blocks[0];
  if (b === undefined) throw new Error("no block");
  return b;
}

async function update(mcp: Client, container: string, text: string) {
  const b = await block(mcp, container);
  const res = await mcp.callTool({
    name: "write_container",
    arguments: {
      container,
      ops: [{ op: "update", slot: b.slot, oldBlobId: b.blobId, text }],
    },
  });
  expect(res.isError).toBeFalsy();
  return res.structuredContent as Out;
}

async function edgeTags(dial: FixtureChaosDial, node: string) {
  return (await dial.edges(node))
    .filter((e) => e.predicate === "hasTag")
    .map((e) => e.value)
    .sort();
}

describe("write_container runs the inline-tag reconcile", () => {
  it("a tag typed into a block lands as an edge and an inline mirror row", async () => {
    const { mcp, dial, tags } = await rig();
    const n = await note(mcp, "Typed");
    const out = await add(mcp, n, "a thought #alpha and #Beta");
    expect(out.tags).toEqual({ added: ["#alpha", "#beta"], removed: [] });
    expect(await edgeTags(dial, n)).toEqual(["#alpha", "#beta"]);
    expect(await tags.byNode(n)).toEqual([
      { tag: "#alpha", source: "inline" },
      { tag: "#beta", source: "inline" },
    ]);
  });

  it("a tag deleted from the prose is retracted from the edge and the mirror", async () => {
    const { mcp, dial, tags } = await rig();
    const n = await note(mcp, "Deleted");
    await add(mcp, n, "keep #alpha drop #beta");
    const out = await update(mcp, n, "keep #alpha");
    expect(out.tags).toEqual({ added: [], removed: ["#beta"] });
    expect(await edgeTags(dial, n)).toEqual(["#alpha"]);
    expect(await tags.byNode(n)).toEqual([{ tag: "#alpha", source: "inline" }]);
  });

  it("explicit (folder / frontmatter) tags survive a save that never names them", async () => {
    const { mcp, dial, tags } = await rig();
    const n = await note(mcp, "Explicit", ["journal"]);
    await mcp.callTool({
      name: "set_properties",
      arguments: { container_id: n, tags: ["#project"] },
    });
    await add(mcp, n, "inline #alpha");
    const out = await update(mcp, n, "no tags left");
    expect(out.tags).toEqual({ added: [], removed: ["#alpha"] });
    expect(await edgeTags(dial, n)).toEqual(["#journal", "#project"]);
    expect(await tags.byNode(n)).toEqual([
      { tag: "#journal", source: "explicit" },
      { tag: "#project", source: "explicit" },
    ]);
  });

  it("an explicit tag also typed inline keeps its provenance and survives its inline removal", async () => {
    const { mcp, dial, tags } = await rig();
    const n = await note(mcp, "Both", ["journal"]);
    const typed = await add(mcp, n, "today #journal");
    expect(typed.tags).toEqual({ added: [], removed: [] });
    await update(mcp, n, "today");
    expect(await edgeTags(dial, n)).toEqual(["#journal"]);
    expect(await tags.byNode(n)).toEqual([
      { tag: "#journal", source: "explicit" },
    ]);
  });

  it("backticked and fenced text never extracts (maskCode)", async () => {
    const { mcp, dial, tags } = await rig();
    const n = await note(mcp, "Code");
    const out = await add(
      mcp,
      n,
      "real #live, `#project` and `#a #b`\n```\n#tags\n```",
    );
    expect(out.tags).toEqual({ added: ["#live"], removed: [] });
    expect(await edgeTags(dial, n)).toEqual(["#live"]);
    expect((await tags.distinct()).map((t) => t.tag)).toEqual(["#live"]);
  });

  it("a save that nets out runs no reconcile", async () => {
    const { mcp, tags } = await rig();
    const n = await note(mcp, "Noop");
    await add(mcp, n, "#alpha");
    // A tag row the prose does not carry: a reconcile would retract it.
    await tags.upsert(n, "#stray", "inline");
    const out = await update(mcp, n, "#alpha");
    expect(out.noop).toBe(true);
    expect(out.tags).toBeUndefined();
    expect(await tags.byNode(n)).toContainEqual({
      tag: "#stray",
      source: "inline",
    });
  });

  it("a save on another tenant never touches the tag path", async () => {
    const { mcp, dial, tags } = await rig();
    const n = await note(mcp, "Issue body");
    const out = await add(mcp, n, "see #alpha", "issues");
    expect(out.tags).toBeUndefined();
    expect(await edgeTags(dial, n)).toEqual([]);
    expect(await tags.byNode(n)).toEqual([]);
  });

  it("a container that is not a Note gets no tags", async () => {
    const { mcp, dial, tags } = await rig();
    const minted = await dial.admit([opCreate("Task", "work")], "notes");
    const work = minted.minted[0] ?? "";
    await dial.admit([opAdd(work, "hasType", { toLiteral: "Task" })], "notes");
    const out = await add(mcp, work, "work prose #alpha");
    expect(out.tags).toBeUndefined();
    expect(await edgeTags(dial, work)).toEqual([]);
    expect(await tags.byNode(work)).toEqual([]);
  });

  it("an archived note gets no inline tags", async () => {
    const { mcp, dial, tags } = await rig();
    const n = await note(mcp, "Archived");
    await dial.admit([opAdd(n, "isArchived", { toLiteral: "true" })], "notes");
    const out = await add(mcp, n, "#include <stdio.h>");
    expect(out.tags).toBeUndefined();
    expect(await tags.byNode(n)).toEqual([]);
  });

  it("without the tag facet the save still lands and reports no tags", async () => {
    const { mcp, dial } = await rig({ tags: false });
    const n = await note(mcp, "Bare");
    const out = await add(mcp, n, "#alpha");
    expect(out.noop).toBe(false);
    expect(out.tags).toBeUndefined();
    expect(out.tags_error).toBeUndefined();
    expect(await edgeTags(dial, n)).toEqual([]);
  });

  it("a reconcile failure never fails the save; the error rides the result", async () => {
    const { mcp, tags } = await rig();
    const n = await note(mcp, "Broken mirror");
    tags.byNode = () => Promise.reject(new Error("mirror down"));
    const out = await add(mcp, n, "#alpha");
    expect(out.noop).toBe(false);
    expect(out.tags).toBeUndefined();
    expect(out.tags_error).toBe("Error: mirror down");
    const b = await block(mcp, n);
    expect(b.slot).toMatch(/^[0-9a-f]{64}$/);
  });

  it("without the chaos facet the save lands and the tag path stays out", async () => {
    const { mcp, dial, tags } = await rig({ chaos: false });
    const minted = await dial.admit([opCreate("Note", "no chaos")], "notes");
    const n = minted.minted[0] ?? "";
    await dial.admit([opAdd(n, "hasType", { toLiteral: "Note" })], "notes");
    const out = await add(mcp, n, "#alpha");
    expect(out.noop).toBe(false);
    expect(out).not.toHaveProperty("tags");
    expect(out).not.toHaveProperty("tags_error");
    expect(await tags.byNode(n)).toEqual([]);
  });

  it("a skipped reconcile adds no tags key at all", async () => {
    const { mcp, dial } = await rig();
    const minted = await dial.admit([opCreate("Task", "work")], "notes");
    const work = minted.minted[0] ?? "";
    const out = await add(mcp, work, "#alpha");
    expect(out).not.toHaveProperty("tags");
  });

  it("a gate refusal of the save is a structured error", async () => {
    const { mcp, dial } = await rig();
    const n = await note(mcp, "Refused");
    dial.admit = () =>
      Promise.resolve({ admitted: false, minted: [], violations: ["no"] });
    const res = await mcp.callTool({
      name: "write_container",
      arguments: {
        container: n,
        ops: [{ op: "add", text: "#alpha", position: "a0" }],
      },
    });
    expect(res.isError).toBe(true);
    const detail =
      "write_container: the gate refused the batch " +
      "(minted blobs remain as orphans for the census; no tree change " +
      'landed) (violations: ["no"])';
    expect(res.structuredContent).toEqual({ code: "admit_refused", detail });
    expect(res.content).toEqual([
      { type: "text", text: `admit_refused: ${detail}` },
    ]);
  });

  it("a failure that is not the gate's propagates as a tool error, unshaped", async () => {
    const dial = new FixtureChaosDial();
    const blobs = new FixtureBlobStore();
    blobs.mint = () => Promise.reject(new Error("blob store down"));
    const server = createServer(new DroppedTableClient(), {
      chaos: { dial, scope: "notes" },
      containers: { blobs, dial },
      tags: new FixtureTagStore(),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(st), mcp.connect(ct)]);
    const n = await note(mcp, "Blobless");
    const res = await mcp.callTool({
      name: "write_container",
      arguments: {
        container: n,
        ops: [{ op: "add", text: "#alpha", position: "a0" }],
      },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    expect(JSON.stringify(res.content)).toContain("blob store down");
  });
});
