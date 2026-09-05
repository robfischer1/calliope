/**
 * Stream of Consciousness pass 4 (specs 048 + 049) — the write verbs publish.
 *
 * Over the fixture rig: a dissolve publishes the note with its tags,
 * provenance and lifecycle; a container write publishes again; a write that
 * nets to nothing publishes nothing; a publisher that refuses never fails the
 * write.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import type {
  NoteProjection,
  NotePublisher,
} from "../src/mcp/consciousness-emit.js";
import { createServer } from "../src/mcp/server.js";
import { FixtureTagStore } from "../src/tag-store.js";

class RecordingPublisher implements NotePublisher {
  published: NoteProjection[] = [];
  refuse = false;
  publish(projection: NoteProjection): Promise<boolean> {
    if (this.refuse) return Promise.resolve(false);
    this.published.push(projection);
    return Promise.resolve(true);
  }
}

async function rig(): Promise<{ mcp: Client; publisher: RecordingPublisher }> {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const publisher = new RecordingPublisher();
  const server = createServer(new FixtureBodyClient(), {
    chaos: { dial, scope: "notes" },
    containers: { blobs, dial },
    tags: new FixtureTagStore(),
    consciousness: publisher,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return { mcp, publisher };
}

async function dissolve(mcp: Client): Promise<string> {
  const result = await mcp.callTool({
    name: "dissolve_note",
    arguments: {
      source_path: "Brain Soup/Idea.md",
      blocks: [{ text: "# Idea" }, { text: "first thought #alpha" }],
      title: "Idea",
      schema_type: "Note",
      mtime: "2026-09-04T00:00:00Z",
      ctime: "2026-09-01T00:00:00Z",
    },
  });
  expect(result.isError).toBeFalsy();
  return (result.structuredContent as { node_id: string }).node_id;
}

describe("the write verbs publish the note (pass 4)", () => {
  it("a dissolve publishes the note with its parts, tags and lifecycle", async () => {
    const { mcp, publisher } = await rig();
    const node = await dissolve(mcp);
    expect(publisher.published).toHaveLength(1);
    const p = publisher.published[0];
    expect(p?.node).toBe(node);
    expect(p?.body).toBe("# Idea\n\nfirst thought #alpha");
    expect(p?.title).toBe("Idea");
    expect(p?.sourcePath).toBe("Brain Soup/Idea.md");
    expect(p?.schemaType).toBe("Note");
    // Tags ride as the graph stores them — the `#tag` form `hasTag` carries.
    expect(p?.tags).toEqual(["#alpha"]);
    expect(p?.createdAt).toBe("2026-09-01T00:00:00Z");
    expect(p?.updatedAt).toBe("2026-09-04T00:00:00Z");
    expect(p?.lifecycle).toBe("active");
    expect(p?.authorKind).toBe("human");
    expect(p?.revision).toBeGreaterThanOrEqual(1);
  });

  it("a container write republishes; a write that nets out does not", async () => {
    const { mcp, publisher } = await rig();
    const node = await dissolve(mcp);
    const read = await mcp.callTool({
      name: "read_container",
      arguments: { container: node },
    });
    const { blocks } = read.structuredContent as {
      blocks: {
        slot: string;
        position: string;
        blobId: string;
        text: string;
      }[];
    };
    const last = blocks.at(-1);
    expect(last).toBeDefined();
    if (last === undefined) return;

    const changed = await mcp.callTool({
      name: "write_container",
      arguments: {
        container: node,
        ops: [
          {
            op: "update",
            slot: last.slot,
            oldBlobId: last.blobId,
            text: "second thought",
          },
        ],
      },
    });
    expect(changed.isError).toBeFalsy();
    expect(publisher.published).toHaveLength(2);
    expect(publisher.published[1]?.body).toBe("# Idea\n\nsecond thought");
    expect(publisher.published[1]?.authorKind).toBeUndefined();

    // The identical text again: blob-first dedup nets the op out, so nothing
    // is written and nothing is published.
    const reread = await mcp.callTool({
      name: "read_container",
      arguments: { container: node },
    });
    const current = (
      reread.structuredContent as { blocks: { slot: string; blobId: string }[] }
    ).blocks.at(-1);
    expect(current).toBeDefined();
    if (current === undefined) return;
    const noop = await mcp.callTool({
      name: "write_container",
      arguments: {
        container: node,
        ops: [
          {
            op: "update",
            slot: current.slot,
            oldBlobId: current.blobId,
            text: "second thought",
          },
        ],
      },
    });
    expect((noop.structuredContent as { noop: boolean }).noop).toBe(true);
    expect(publisher.published).toHaveLength(2);
  });

  it("a refusing publisher never fails the write", async () => {
    const { mcp, publisher } = await rig();
    publisher.refuse = true;
    const node = await dissolve(mcp);
    expect(node).toMatch(/^[0-9a-f]{64}$/);
    expect(publisher.published).toHaveLength(0);
  });

  it("without a publisher the verbs behave exactly as before", async () => {
    const dial = new FixtureChaosDial();
    const server = createServer(new FixtureBodyClient(), {
      chaos: { dial, scope: "notes" },
      containers: { blobs: new FixtureBlobStore(), dial },
      tags: new FixtureTagStore(),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(st), mcp.connect(ct)]);
    const node = await dissolve(mcp);
    expect(node).toMatch(/^[0-9a-f]{64}$/);
  });
});
