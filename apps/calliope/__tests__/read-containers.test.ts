/**
 * calliope_read_containers — the batch read. nomos made ~96 serial
 * read_container calls per read; this verb answers them in one. Over the
 * fixture dial: parity with N single reads, the texts:false fence (no blob
 * fetch), unknown ids in `missing`, the 500 ceiling, and the revision.
 */

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial, opAdd, opCreate } from "../src/chaos-client.js";
import { readContainer, readContainers } from "../src/container-read.js";
import { writeContainer } from "../src/container-write.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { createServer } from "../src/mcp/server.js";
import { readTree, slotBirthOps } from "../src/tree.js";

/** Counts the blob fetches so "no blob fetch" is an observation. */
class CountingBlobs extends FixtureBlobStore {
  fetches = 0;
  override getTexts(ids: string[]): Promise<Map<string, string>> {
    this.fetches += 1;
    return super.getTexts(ids);
  }
}

/** A dial that fails if the batch loops the per-node edge read. */
class NoEdgesDial extends FixtureChaosDial {
  edgeCalls = 0;
  override edges(token: string) {
    this.edgeCalls += 1;
    return super.edges(token);
  }
}

async function setup() {
  const dial = new NoEdgesDial();
  const blobs = new CountingBlobs();
  const facet = { blobs, dial };
  const mint = async (label: string): Promise<string> => {
    const res = await dial.admit([opCreate("Note", label)], "notes");
    const id = res.minted[0];
    if (id === undefined) throw new Error("fixture minted nothing");
    return id;
  };
  const a = await mint("a");
  const b = await mint("b");
  const c = await mint("c");
  await writeContainer(facet, a, [
    { op: "add", text: "a-two", position: "a1" },
    { op: "add", text: "a-one", position: "a0" },
  ]);
  await writeContainer(facet, b, [
    { op: "add", text: "b-one", position: "a0" },
  ]);
  await dial.admit(
    [opAdd(b, "frontmatter", { toLiteral: "tags: [x]" })],
    "notes",
  );
  // c stays an empty (but existing) container with no members.
  return { dial, blobs, facet, a, b, c, mint };
}

describe("calliope_read_containers", () => {
  it("matches N single reads: same blocks, blobIds, order", async () => {
    const { facet, a, b, blobs, dial } = await setup();
    const batch = await readContainers(facet, [b, a], { texts: true });
    expect(batch.missing).toEqual([]);
    expect(batch.containers.map((c) => c.container)).toEqual([b, a]);
    for (const got of batch.containers) {
      const single = await readContainer(facet, got.container);
      expect(got.blocks).toEqual(single.blocks);
    }
    expect(
      batch.containers[1]?.blocks.map((x) => [x.position, x.text]),
    ).toEqual([
      ["a0", "a-one"],
      ["a1", "a-two"],
    ]);
    // One batch = one blob fetch, and never the per-node edge walk.
    const before = blobs.fetches;
    dial.edgeCalls = 0;
    await readContainers(facet, [a, b], { texts: true });
    expect(blobs.fetches - before).toBe(1);
    expect(dial.edgeCalls).toBe(0);
  });

  it("surfaces frontmatter, and dangling blocks as the single read does", async () => {
    const { facet, dial, a, b } = await setup();
    await dial.admit(slotBirthOps(a, "b:z", "z0", "999999"), "notes");
    const batch = await readContainers(facet, [a, b], { texts: true });
    expect(batch.containers[1]?.frontmatter).toBe("tags: [x]");
    expect(batch.containers[0]?.frontmatter).toBeNull();
    const dangling = batch.containers[0]?.blocks.find(
      (x) => x.blobId === "999999",
    );
    expect(dangling).toMatchObject({ text: null, dangling: true });
    expect(batch.containers[0]?.blocks).toEqual(
      (await readContainer(facet, a)).blocks,
    );
  });

  it("texts:false leaves text null and makes no blob fetch", async () => {
    const { facet, blobs, a, b } = await setup();
    const before = blobs.fetches;
    const batch = await readContainers(facet, [a, b], { texts: false });
    expect(blobs.fetches).toBe(before);
    const blocks = batch.containers.flatMap((c) => c.blocks);
    expect(blocks).toHaveLength(3);
    expect(blocks.every((x) => x.text === null && x.blobId !== null)).toBe(
      true,
    );
    expect(blocks.every((x) => !x.dangling)).toBe(true);
    // Same structure and the same revision as the texts read.
    const full = await readContainers(facet, [a, b], { texts: true });
    expect(batch.containers.map((c) => [c.container, c.revision])).toEqual(
      full.containers.map((c) => [c.container, c.revision]),
    );
  });

  it("puts unknown ids (and memberless, frontmatterless nodes) in missing", async () => {
    const { facet, a, c } = await setup();
    const ghost = "f".repeat(64);
    const batch = await readContainers(facet, [ghost, a, c], { texts: true });
    expect(batch.containers.map((x) => x.container)).toEqual([a]);
    expect(batch.missing).toEqual([ghost, c]);
  });

  it("revision is stable, and changes when one block changes", async () => {
    const { facet, a, b } = await setup();
    const rev = async (id: string) =>
      (await readContainers(facet, [id], { texts: true })).containers[0]
        ?.revision;
    const first = await rev(a);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await rev(a)).toBe(first);
    const other = await rev(b);
    expect(other).not.toBe(first);

    const [slot] = await readTree(facet.dial, a);
    if (slot?.blobId == null) throw new Error("bad setup");
    await writeContainer(facet, a, [
      { op: "update", slot: slot.slot, oldBlobId: slot.blobId, text: "edited" },
    ]);
    const changed = await rev(a);
    expect(changed).not.toBe(first);
    expect(await rev(b)).toBe(other); // the neighbour is untouched

    // Frontmatter is part of the revision.
    await facet.dial.admit(
      [opAdd(a, "frontmatter", { toLiteral: "title: t" })],
      "notes",
    );
    expect(await rev(a)).not.toBe(changed);
  });
});

describe("read_containers over the wire", () => {
  async function wire() {
    const { facet, dial, a, b } = await setup();
    const server = createServer(new FixtureBodyClient(), {
      chaos: { dial, scope: "notes" },
      containers: facet,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(st), mcp.connect(ct)]);
    return { mcp, a, b };
  }

  it("answers the contract shape; texts defaults to true", async () => {
    const { mcp, a } = await wire();
    const ghost = "e".repeat(64);
    const res = await mcp.callTool({
      name: "read_containers",
      arguments: { containers: [a, ghost] },
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as {
      containers: { blocks: { text: string | null }[] }[];
      missing: string[];
    };
    expect(out.containers[0]?.blocks.map((x) => x.text)).toEqual([
      "a-one",
      "a-two",
    ]);
    expect(out.missing).toEqual([ghost]);
  });

  it("refuses more than 500 ids, and none, as bad_args", async () => {
    const { mcp } = await wire();
    const ids = Array.from(
      { length: 501 },
      (_, i) => "d" + i.toString(16).padStart(63, "0"),
    );
    for (const containers of [ids, []]) {
      const res = await mcp.callTool({
        name: "read_containers",
        arguments: { containers },
      });
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toMatchObject({ code: "bad_args" });
    }
    const ok = await mcp.callTool({
      name: "read_containers",
      arguments: { containers: ids.slice(0, 500), texts: false },
    });
    expect(ok.isError).toBeFalsy();
    expect(
      (ok.structuredContent as { missing: string[] }).missing,
    ).toHaveLength(500);
  });
});
