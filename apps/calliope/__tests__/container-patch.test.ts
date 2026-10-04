/**
 * patch_container — literal find/replace inside a container's blocks,
 * landed server-side as ONE save, all-or-nothing on its counts.
 *
 * Every master-plan on the notes graph is one block of 13–156 KB, and the
 * only edit path carried the whole text. These pin the planner (counts,
 * sequencing, targeting, refusals) and the verb (one transaction, the tx
 * id, a refusal writes nothing, tags reconcile, non-notes tenants skip it).
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial, opCreate } from "../src/chaos-client.js";
import {
  countLiteral,
  isPatchError,
  patchContainer,
  planPatch,
} from "../src/container-patch.js";
import type { ContainerBlock } from "../src/container-read.js";
import { writeContainer } from "../src/container-write.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { createServer } from "../src/mcp/server.js";
import { FixtureTagStore } from "../src/tag-store.js";

const S1 = "1".repeat(64);
const S2 = "2".repeat(64);
const S3 = "3".repeat(64);

function blk(
  slot: string,
  text: string | null,
  blobId = `b-${slot}`,
): ContainerBlock {
  return {
    slot,
    position: `a${slot.slice(0, 1)}`,
    blobId: text === null ? null : blobId,
    text,
    dangling: text === null,
  };
}

describe("countLiteral", () => {
  it("counts non-overlapping literal occurrences, left to right", () => {
    expect(countLiteral("aaaa", "aa")).toBe(2);
    expect(countLiteral("a.b.c", ".")).toBe(2);
    expect(countLiteral("no hit", "x")).toBe(0);
    expect(countLiteral("Case case", "case")).toBe(1);
  });
});

describe("planPatch", () => {
  const blocks = [
    blk(S1, "one #a\ntwo #a"),
    blk(S2, "three #a"),
    blk(S3, null),
  ];

  it("sums counts over every block when no slot is named, skipping dangling ones", () => {
    const plan = planPatch(blocks, undefined, [
      { find: "#a", replace: "`#a`", expected_count: 3 },
    ]);
    if ("error" in plan) return;
    expect(plan.counts).toEqual([{ expected: 3, found: 3 }]);
    expect(plan.changed.map((c) => [c.block.slot, c.text])).toEqual([
      [S1, "one `#a`\ntwo `#a`"],
      [S2, "three `#a`"],
    ]);
  });

  it("targets one slot when named", () => {
    const plan = planPatch(blocks, S2, [
      { find: "#a", replace: "#b", expected_count: 1 },
    ]);
    if ("error" in plan) throw new Error(plan.detail);
    expect(plan.changed.map((c) => c.block.slot)).toEqual([S2]);
  });

  it("runs replacements in order, each on the text the earlier ones left", () => {
    const plan = planPatch([blk(S1, "x")], undefined, [
      { find: "x", replace: "yy", expected_count: 1 },
      { find: "y", replace: "z", expected_count: 2 },
    ]);
    if ("error" in plan) throw new Error(plan.detail);
    expect(plan.changed[0]?.text).toBe("zz");
    expect(plan.counts).toEqual([
      { expected: 1, found: 1 },
      { expected: 2, found: 2 },
    ]);
  });

  it("refuses the whole batch on any count miss, with every tally", () => {
    const plan = planPatch(blocks, undefined, [
      { find: "one", replace: "1", expected_count: 1 },
      { find: "#a", replace: "#b", expected_count: 2 },
      { find: "absent", replace: "", expected_count: 1 },
    ]);
    expect("error" in plan && plan.error).toBe("count_mismatch");
    if (!("error" in plan)) return;
    expect(plan.counts).toEqual([
      { expected: 1, found: 1 },
      { expected: 2, found: 3 },
      { expected: 1, found: 0 },
    ]);
    expect(plan.detail).toBe(
      "replacement 1: expected 2, found 3; replacement 2: expected 1, found 0",
    );
  });

  it("an expected_count of 0 asserts absence", () => {
    const plan = planPatch(blocks, undefined, [
      { find: "absent", replace: "x", expected_count: 0 },
    ]);
    if ("error" in plan) throw new Error(plan.detail);
    expect(plan.changed).toEqual([]);
  });

  it("an identity replacement changes nothing", () => {
    const plan = planPatch(blocks, undefined, [
      { find: "one", replace: "one", expected_count: 1 },
    ]);
    if ("error" in plan) throw new Error(plan.detail);
    expect(plan.changed).toEqual([]);
  });

  it("refuses an empty find, an empty container, an unknown slot and a dangling slot", () => {
    const r = [{ find: "a", replace: "b", expected_count: 0 }];
    expect(
      planPatch(blocks, undefined, [
        { find: "a", replace: "b", expected_count: 0 },
        { find: "", replace: "b", expected_count: 0 },
      ]),
    ).toEqual({
      error: "empty_find",
      detail: "replacement 1 has an empty find",
    });
    expect(planPatch([], undefined, r)).toEqual({
      error: "empty_container",
      detail: "the container has no blocks",
    });
    expect(planPatch(blocks, "f".repeat(64), r)).toEqual({
      error: "bad_slot",
      detail: `${"f".repeat(64)} is not in the container`,
    });
    expect(planPatch(blocks, S3, r)).toEqual({
      error: "dangling_slot",
      detail: `${S3} names an absent blob; there is no text to patch`,
    });
  });
});

async function seeded() {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const facet = { blobs, dial };
  const minted = await dial.admit([opCreate("Note", "plan")], "notes");
  const doc = minted.minted[0] ?? "";
  await writeContainer(facet, doc, [
    { op: "add", text: "alpha ⬜ one\nalpha ⬜ two", position: "a0" },
    { op: "add", text: "beta ⬜ three", position: "a1" },
  ]);
  return { dial, blobs, facet, doc };
}

describe("patchContainer", () => {
  it("lands every changed block in ONE admit and returns its tx", async () => {
    const { dial, facet, doc } = await seeded();
    const before = dial.admits.length;
    const res = await patchContainer(facet, {
      container: doc,
      replacements: [{ find: "⬜", replace: "- [ ]", expected_count: 3 }],
    });
    if (isPatchError(res)) throw new Error(res.detail);
    expect(dial.admits.length).toBe(before + 1);
    expect(res.noop).toBe(false);
    expect(typeof res.tx).toBe("number");
    expect(res.slots_changed).toHaveLength(2);
    expect(res.counts).toEqual([{ expected: 3, found: 3 }]);
  });

  it("a count miss writes nothing — no blob, no admit", async () => {
    const { dial, blobs, facet, doc } = await seeded();
    const admits = dial.admits.length;
    const size = blobs.size;
    const res = await patchContainer(facet, {
      container: doc,
      replacements: [{ find: "⬜", replace: "- [ ]", expected_count: 2 }],
    });
    expect(isPatchError(res) && res.error).toBe("count_mismatch");
    expect(dial.admits.length).toBe(admits);
    expect(blobs.size).toBe(size);
  });

  it("a batch that changes nothing is a noop without a transaction", async () => {
    const { dial, facet, doc } = await seeded();
    const admits = dial.admits.length;
    const res = await patchContainer(facet, {
      container: doc,
      replacements: [{ find: "zzz", replace: "y", expected_count: 0 }],
    });
    expect(res).toEqual({
      container: doc,
      noop: true,
      counts: [{ expected: 0, found: 0 }],
      slots_changed: [],
    });
    expect(dial.admits.length).toBe(admits);
  });
});

async function rig() {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const tags = new FixtureTagStore();
  const server = createServer(new FixtureBodyClient(), {
    chaos: { dial, scope: "notes" },
    containers: { blobs, dial },
    tags,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  const created = await mcp.callTool({
    name: "create_note",
    arguments: { title: "Master plan" },
  });
  const node = (created.structuredContent as { node_id: string }).node_id;
  await mcp.callTool({
    name: "write_container",
    arguments: {
      container: node,
      ops: [{ op: "add", text: "uses #project and #b here", position: "a0" }],
    },
  });
  return { mcp, dial, tags, node };
}

interface Out {
  error?: string;
  noop?: boolean;
  tx?: number;
  counts?: unknown;
  tags?: { added: string[]; removed: string[] };
  violations?: unknown[];
}

describe("the patch_container verb", () => {
  it("patches the text, reports the tx, and reconciles the inline tags", async () => {
    const { mcp, tags, node } = await rig();
    expect((await tags.byNode(node)).map((r) => r.tag)).toEqual([
      "#b",
      "#project",
    ]);
    const res = await mcp.callTool({
      name: "patch_container",
      arguments: {
        container: node,
        replacements: [
          { find: "#project", replace: "`#project`", expected_count: 1 },
          { find: "#b ", replace: "`#b` ", expected_count: 1 },
        ],
      },
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as Out;
    expect(typeof out.tx).toBe("number");
    expect(out.tags).toEqual({ added: [], removed: ["#b", "#project"] });
    expect(await tags.byNode(node)).toEqual([]);
    expect(res.content).toEqual([
      { type: "text", text: `patched 1 block(s) in tx ${String(out.tx)}` },
    ]);
    const read = await mcp.callTool({
      name: "read_container",
      arguments: { container: node },
    });
    expect(
      (read.structuredContent as { blocks: { text: string }[] }).blocks[0]
        ?.text,
    ).toBe("uses `#project` and `#b` here");
  });

  it("a count miss is a structured refusal and leaves the text alone", async () => {
    const { mcp, node } = await rig();
    const res = await mcp.callTool({
      name: "patch_container",
      arguments: {
        container: node,
        replacements: [{ find: "#b", replace: "x", expected_count: 5 }],
      },
    });
    expect(res.isError).toBe(true);
    const out = res.structuredContent as Out;
    expect(out.error).toBe("count_mismatch");
    expect(out.counts).toEqual([{ expected: 5, found: 1 }]);
    expect(res.content).toEqual([
      {
        type: "text",
        text: "count_mismatch: replacement 0: expected 5, found 1",
      },
    ]);
  });

  it("a noop patch reports so and runs no reconcile", async () => {
    const { mcp, node } = await rig();
    const res = await mcp.callTool({
      name: "patch_container",
      arguments: {
        container: node,
        replacements: [{ find: "absent", replace: "x", expected_count: 0 }],
      },
    });
    const out = res.structuredContent as Out;
    expect(out.noop).toBe(true);
    expect(out.tags).toBeUndefined();
    expect(res.content).toEqual([
      { type: "text", text: "noop: the replacements changed nothing" },
    ]);
  });

  it("a non-notes tenant patch skips the tag path", async () => {
    const { mcp, dial, node } = await rig();
    const res = await mcp.callTool({
      name: "patch_container",
      arguments: {
        container: node,
        tenant: "issues",
        replacements: [{ find: "#b", replace: "#c", expected_count: 1 }],
      },
    });
    const out = res.structuredContent as Out;
    expect(out.noop).toBe(false);
    expect(out.tags).toBeUndefined();
    const edgeTags = (await dial.edges(node))
      .filter((e) => e.predicate === "hasTag")
      .map((e) => e.value)
      .sort();
    expect(edgeTags).toEqual(["#b", "#project"]);
  });

  it("a gate refusal surfaces its code and violations", async () => {
    const { mcp, dial, node } = await rig();
    dial.admit = () =>
      Promise.resolve({ admitted: false, minted: [], violations: ["nope"] });
    const res = await mcp.callTool({
      name: "patch_container",
      arguments: {
        container: node,
        replacements: [{ find: "#b", replace: "#c", expected_count: 1 }],
      },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toEqual({
      error: "admit_refused",
      violations: ["nope"],
    });
  });

  it("refuses a malformed slot and an empty replacement list at the schema", async () => {
    const { mcp, node } = await rig();
    const badSlot = await mcp.callTool({
      name: "patch_container",
      arguments: {
        container: node,
        slot: "nope",
        replacements: [{ find: "a", replace: "b", expected_count: 0 }],
      },
    });
    expect(badSlot.isError).toBe(true);
    const empty = await mcp.callTool({
      name: "patch_container",
      arguments: { container: node, replacements: [] },
    });
    expect(empty.isError).toBe(true);
  });
});
