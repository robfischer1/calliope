/**
 * calliope#5290 — the note verbs read and write prose through the TREE.
 *
 * On the live star, after the F12 cut dropped `sections`, every
 * materialize_note(container_id) erred `relation "sections" does not exist`
 * while read_container on the same id answered the blocks. The regression
 * pin here: hand the server a body client that THROWS on any body call (the
 * post-cut pg client's behaviour) and prove dissolve / materialize / export
 * still work, because they never touch it.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { bodyDiffOps, containerBodies } from "../src/container-body.js";
import type { ContainerBlock } from "../src/container-read.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { createServer } from "../src/mcp/server.js";
import { FixtureTagStore } from "../src/tag-store.js";

/** The post-cut pg body client, as the fleet sees it: every body read or
 *  write reaches a table that is gone. */
class DroppedTableClient extends FixtureBodyClient {
  override readBody(): Promise<never> {
    return Promise.reject(new Error('relation "sections" does not exist'));
  }
  override saveBody(): Promise<never> {
    return Promise.reject(new Error('relation "sections" does not exist'));
  }
}

async function rig(): Promise<{ mcp: Client; dial: FixtureChaosDial }> {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const server = createServer(new DroppedTableClient(), {
    chaos: { dial, scope: "notes" },
    containers: { blobs, dial },
    tags: new FixtureTagStore(),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return { mcp, dial };
}

type Blocks = { id: string; text: string; orderKey: string }[];

describe("the note verbs over a dropped-table body client (calliope#5290)", () => {
  it("dissolve lands the tree; materialize by id and by path read it back", async () => {
    const { mcp } = await rig();
    const dissolved = await mcp.callTool({
      name: "dissolve_note",
      arguments: {
        source_path: "Brain Soup/Idea.md",
        blocks: [{ text: "# Idea" }, { text: "first" }, { text: "second" }],
        title: "Idea",
      },
    });
    expect(dissolved.isError).toBeFalsy();
    const { node_id, generation } = dissolved.structuredContent as {
      node_id: string;
      generation: string;
    };
    expect(generation).toBe("minted");

    const byId = await mcp.callTool({
      name: "materialize_note",
      arguments: { container_id: node_id },
    });
    expect(byId.isError).toBeFalsy();
    const mat = byId.structuredContent as {
      container_id: string;
      blocks: Blocks;
      provenance: Record<string, string>;
    };
    expect(mat.container_id).toBe(node_id);
    expect(mat.blocks.map((b) => b.text)).toEqual([
      "# Idea",
      "first",
      "second",
    ]);
    expect(mat.provenance.source_path).toBe("Brain Soup/Idea.md");

    // The same blocks read_container answers — one tree, two doors.
    const tree = await mcp.callTool({
      name: "read_container",
      arguments: { container: node_id },
    });
    const { blocks } = tree.structuredContent as { blocks: ContainerBlock[] };
    expect(blocks.map((b) => b.slot)).toEqual(mat.blocks.map((b) => b.id));
    expect(blocks.map((b) => b.position)).toEqual(
      mat.blocks.map((b) => b.orderKey),
    );

    const byPath = await mcp.callTool({
      name: "materialize_note",
      arguments: { source_path: "Brain Soup/Idea.md" },
    });
    expect(
      (byPath.structuredContent as { blocks: Blocks }).blocks.map(
        (b) => b.text,
      ),
    ).toEqual(["# Idea", "first", "second"]);

    const exported = await mcp.callTool({
      name: "export_note",
      arguments: { container_id: node_id },
    });
    expect(exported.structuredContent).toEqual({
      container_id: node_id,
      markdown: "# Idea\n\nfirst\n\nsecond",
      block_count: 3,
    });
  });

  it("a re-dissolve noops on identical content and supersedes in place on a change", async () => {
    const { mcp } = await rig();
    const first = await mcp.callTool({
      name: "dissolve_note",
      arguments: {
        source_path: "n.md",
        blocks: [{ text: "a" }, { text: "b" }],
      },
    });
    const { node_id } = first.structuredContent as { node_id: string };
    const before = (
      (
        await mcp.callTool({
          name: "materialize_note",
          arguments: { container_id: node_id },
        })
      ).structuredContent as { blocks: Blocks }
    ).blocks;

    const same = await mcp.callTool({
      name: "dissolve_note",
      arguments: {
        source_path: "n.md",
        blocks: [{ text: "a" }, { text: "b" }],
      },
    });
    expect((same.structuredContent as { generation: string }).generation).toBe(
      "nooped",
    );

    const changed = await mcp.callTool({
      name: "dissolve_note",
      arguments: {
        source_path: "n.md",
        blocks: [{ text: "a" }, { text: "B" }, { text: "c" }],
      },
    });
    expect(
      (changed.structuredContent as { generation: string }).generation,
    ).toBe("superseded");
    const after = (
      (
        await mcp.callTool({
          name: "materialize_note",
          arguments: { container_id: node_id },
        })
      ).structuredContent as { blocks: Blocks }
    ).blocks;
    expect(after.map((b) => b.text)).toEqual(["a", "B", "c"]);
    // Slot identity survives the edit: the shared prefix keeps its ids.
    expect(after.slice(0, 2).map((b) => b.id)).toEqual(before.map((b) => b.id));
  });

  it("a miss is still container_not_found, not a table error", async () => {
    const { mcp } = await rig();
    const miss = await mcp.callTool({
      name: "materialize_note",
      arguments: { container_id: "f".repeat(64) },
    });
    expect(miss.isError).toBe(true);
    expect(miss.structuredContent).toMatchObject({
      error: "container_not_found",
    });
    // export_note: no handle at all, an unknown path, an unknown id — every
    // miss is the structured container_not_found, never a body-client call.
    for (const args of [
      {},
      { source_path: "never/dissolved.md" },
      { container_id: "e".repeat(64) },
    ]) {
      const res = await mcp.callTool({ name: "export_note", arguments: args });
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toMatchObject({
        error: "container_not_found",
      });
    }
  });

  it("without a containers facet the note verbs ride the body client (the fixture-only shape)", async () => {
    const dial = new FixtureChaosDial();
    const server = createServer(new FixtureBodyClient(), {
      chaos: { dial, scope: "notes" },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(st), mcp.connect(ct)]);
    const dissolved = await mcp.callTool({
      name: "dissolve_note",
      arguments: { source_path: "c.md", blocks: [{ text: "client-backed" }] },
    });
    expect(dissolved.isError).toBeFalsy();
    const { node_id } = dissolved.structuredContent as { node_id: string };
    const exported = await mcp.callTool({
      name: "export_note",
      arguments: { container_id: node_id },
    });
    expect(exported.structuredContent).toMatchObject({
      markdown: "client-backed",
      block_count: 1,
    });
  });

  it("write_container scopes the admit to each tenant, issues included", async () => {
    const { mcp, dial } = await rig();
    const tenants = ["notes", "documents", "comments", "governance", "issues"];
    for (const tenant of tenants) {
      const minted = await dial.admit(
        [{ op: "createNode", kind: "Note", label: `c-${tenant}` }],
        tenant,
      );
      const container = minted.minted[0] ?? "";
      const res = await mcp.callTool({
        name: "write_container",
        arguments: {
          container,
          ops: [{ op: "add", text: `in ${tenant}`, position: "5" }],
          tenant,
        },
      });
      expect(res.isError, tenant).toBeFalsy();
      expect(dial.admits.at(-1)?.scope).toBe(tenant);
    }
    const bogus = await mcp.callTool({
      name: "write_container",
      arguments: {
        container: "a".repeat(64),
        ops: [{ op: "add", text: "x", position: "5" }],
        tenant: "bogus",
      },
    });
    expect(bogus.isError).toBe(true);
  });
});

describe("bodyDiffOps", () => {
  const block = (
    slot: string,
    position: string,
    text: string,
  ): ContainerBlock => ({
    slot,
    position,
    blobId: `blob-${text}`,
    text,
    dangling: false,
  });

  it("updates the shared prefix in place, appends after the tail, removes the surplus", () => {
    const ops = bodyDiffOps(
      [block("s1", "1", "a"), block("s2", "2", "b"), block("s3", "3", "c")],
      [{ text: "a" }, { text: "B" }],
    );
    expect(ops).toEqual([
      { op: "update", slot: "s2", oldBlobId: "blob-b", text: "B" },
      { op: "remove", slot: "s3", position: "3", blobId: "blob-c" },
    ]);
    const grown = bodyDiffOps(
      [block("s1", "1", "a")],
      [{ text: "a" }, { text: "x" }, { text: "y" }],
    );
    expect(grown.map((o) => o.op)).toEqual(["add", "add"]);
    const positions = grown.map((o) => (o.op === "add" ? o.position : ""));
    const [p0 = "", p1 = ""] = positions;
    expect(p0 > "1" && p1 > p0).toBe(true);
  });

  it("an empty diff is no ops, and a dangling surplus slot is left for the census", () => {
    expect(bodyDiffOps([block("s1", "1", "a")], [{ text: "a" }])).toEqual([]);
    const dangling: ContainerBlock = {
      slot: "s2",
      position: "2",
      blobId: null,
      text: null,
      dangling: true,
    };
    expect(
      bodyDiffOps([block("s1", "1", "a"), dangling], [{ text: "a" }]),
    ).toEqual([]);
  });

  it("containerBodies reads and writes one container through the facet", async () => {
    const dial = new FixtureChaosDial();
    const blobs = new FixtureBlobStore();
    const bodies = containerBodies({ blobs, dial });
    const [container] = await dial.findByName("Note", "never");
    expect(container).toBeUndefined();
    const res = await dial.admit(
      [{ op: "createNode", kind: "Note", label: "c" }],
      "notes",
    );
    const token = res.minted[0] ?? "";
    expect(token).not.toBe("");
    await bodies.saveBody(token, [{ text: "one" }, { text: "two" }]);
    expect((await bodies.readBody(token)).map((s) => s.text)).toEqual([
      "one",
      "two",
    ]);
    await bodies.saveBody(token, [{ text: "one" }]);
    expect((await bodies.readBody(token)).map((s) => s.text)).toEqual(["one"]);
  });
});
