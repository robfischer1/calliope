/**
 * Stream of Consciousness pass 4, F3 (spec 050) — the container does not
 * care who is writing.
 *
 * mnemosyne (pass 3 F1) stores a memory's prose as an ordinary Calliope note
 * titled `memory:<scope>:<name>` holding one block, through the same three
 * verbs any writer uses. This pins that nothing in the container model is
 * note-specific: no frontmatter, no tags, no provenance attributes are
 * required; the prose round-trips byte-for-byte; the identity is the
 * container token; and a memory-shaped body (a retraction banner, a rule)
 * is treated as prose — no schema, no validation, no interpretation.
 *
 * The expectation was that nothing here fails. The value is in having
 * looked: an assumption nobody knew was there is the failure mode this test
 * rules out, and it costs one test.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { createServer } from "../src/mcp/server.js";
import { FixtureTagStore } from "../src/tag-store.js";

async function rig(): Promise<Client> {
  const dial = new FixtureChaosDial();
  const server = createServer(new FixtureBodyClient(), {
    chaos: { dial, scope: "notes" },
    containers: { blobs: new FixtureBlobStore(), dial },
    tags: new FixtureTagStore(),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return mcp;
}

// A memory body exactly as mnemosyne's `_stamp_retraction` writes one: a
// banner, a rule, the prose. Calliope must see prose and nothing else.
const MEMORY_BODY =
  "> **SUPERSEDED 2026-09-05** by `probe_mem_v2` — the cutover landed.\n\n" +
  "---\n\n" +
  "The body: one artifact, asserted twice. Trailing whitespace kept.  ";

describe("a non-note writer's container (pass 4 F3)", () => {
  it("mints on a title alone, holds one prose block, and reads back byte-for-byte", async () => {
    const mcp = await rig();
    const created = await mcp.callTool({
      name: "create_note",
      arguments: { title: "memory:mnemosyne:probe_mem" },
    });
    expect(created.isError).toBeFalsy();
    const { node_id } = created.structuredContent as { node_id: string };
    expect(node_id).toMatch(/^[0-9a-f]{64}$/);

    const written = await mcp.callTool({
      name: "write_container",
      arguments: {
        container: node_id,
        ops: [{ op: "add", text: MEMORY_BODY, position: "5" }],
      },
    });
    expect(written.isError).toBeFalsy();
    const result = written.structuredContent as {
      noop: boolean;
      applied: number[];
    };
    expect(result.noop).toBe(false);
    expect(result.applied).toEqual([0]);

    const read = await mcp.callTool({
      name: "read_container",
      arguments: { container: node_id },
    });
    const { blocks } = read.structuredContent as {
      blocks: { text: string; dangling: boolean }[];
    };
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.dangling).toBe(false);
    expect(blocks[0]?.text).toBe(MEMORY_BODY);

    // The note-side read sees prose with NO tags and NO provenance — nothing
    // it needed was ever required of the writer.
    const materialized = await mcp.callTool({
      name: "materialize_note",
      arguments: { container_id: node_id },
    });
    expect(materialized.isError).toBeFalsy();
    const view = materialized.structuredContent as {
      container_id: string;
      blocks: { text: string }[];
      tags: string[];
      provenance: Record<string, string>;
    };
    expect(view.container_id).toBe(node_id);
    expect(view.blocks.map((b) => b.text)).toEqual([MEMORY_BODY]);
    expect(view.tags).toEqual([]);
    expect(view.provenance.source_path).toBeUndefined();
  });

  it("is idempotent on the title and updates the one block in place", async () => {
    const mcp = await rig();
    const first = await mcp.callTool({
      name: "create_note",
      arguments: { title: "memory:mnemosyne:probe_mem" },
    });
    const again = await mcp.callTool({
      name: "create_note",
      arguments: { title: "memory:mnemosyne:probe_mem" },
    });
    const a = first.structuredContent as { node_id: string; created: boolean };
    const b = again.structuredContent as { node_id: string; created: boolean };
    expect(b.node_id).toBe(a.node_id);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);

    await mcp.callTool({
      name: "write_container",
      arguments: {
        container: a.node_id,
        ops: [{ op: "add", text: "v1", position: "5" }],
      },
    });
    const before = (
      (
        await mcp.callTool({
          name: "read_container",
          arguments: { container: a.node_id },
        })
      ).structuredContent as {
        blocks: { slot: string; blobId: string; text: string }[];
      }
    ).blocks;
    expect(before.map((x) => x.text)).toEqual(["v1"]);
    const slot = before[0];
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    await mcp.callTool({
      name: "write_container",
      arguments: {
        container: a.node_id,
        ops: [
          { op: "update", slot: slot.slot, oldBlobId: slot.blobId, text: "v2" },
        ],
      },
    });
    const after = (
      (
        await mcp.callTool({
          name: "read_container",
          arguments: { container: a.node_id },
        })
      ).structuredContent as { blocks: { slot: string; text: string }[] }
    ).blocks;
    expect(after.map((x) => x.text)).toEqual(["v2"]);
    expect(after[0]?.slot).toBe(slot.slot); // the slot is the stable handle
  });
});
