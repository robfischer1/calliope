/**
 * write_container({replacements}) — literal find/replace inside a
 * container's blocks, landed server-side as ONE save, all-or-nothing on its
 * counts.
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
import { type ContainerBlock, readContainer } from "../src/container-read.js";
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
    if ("error" in plan) throw new Error(plan.detail);
    expect(plan.counts).toEqual([{ expected: 3, found: 3 }]);
    expect(plan.changed).toEqual([
      {
        slot: S1,
        blobId: `b-${S1}`,
        from: "one #a\ntwo #a",
        text: "one `#a`\ntwo `#a`",
      },
      { slot: S2, blobId: `b-${S2}`, from: "three #a", text: "three `#a`" },
    ]);
  });

  it("targets one slot when named", () => {
    const plan = planPatch(blocks, S2, [
      { find: "#a", replace: "#b", expected_count: 1 },
    ]);
    if ("error" in plan) throw new Error(plan.detail);
    expect(plan.changed.map((c) => c.slot)).toEqual([S2]);
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

  it("a block whose content fact names an absent blob is dangling, in both modes", () => {
    const gone: ContainerBlock = {
      slot: S3,
      position: "a3",
      blobId: "b-gone",
      text: null,
      dangling: true,
    };
    const r = [{ find: "#a", replace: "#b", expected_count: 3 }];
    const all = planPatch([...blocks.slice(0, 2), gone], undefined, r);
    if ("error" in all) throw new Error(all.detail);
    expect(all.changed.map((c) => c.slot)).toEqual([S1, S2]);
    expect(planPatch([gone], S3, r)).toMatchObject({ error: "dangling_slot" });
  });

  it("a block with text but no blob id is not a target", () => {
    const odd: ContainerBlock = {
      slot: S3,
      position: "a3",
      blobId: null,
      text: "#a",
      dangling: false,
    };
    const r = [{ find: "#a", replace: "#b", expected_count: 3 }];
    const all = planPatch([...blocks.slice(0, 2), odd], undefined, r);
    if ("error" in all) throw new Error(all.detail);
    expect(all.changed.map((c) => c.slot)).toEqual([S1, S2]);
    expect(planPatch([odd], S3, r)).toMatchObject({ error: "dangling_slot" });
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
    const tree = await readContainer(facet, doc);
    expect(res.slots_changed).toEqual(tree.blocks.map((b) => b.slot));
    expect(res.counts).toEqual([{ expected: 3, found: 3 }]);
    // The default tenant is notes: the batch rode the notes scope.
    expect(dial.admits.at(-1)?.scope).toBe("notes");
    expect(tree.blocks.map((b) => b.text)).toEqual([
      "alpha - [ ] one\nalpha - [ ] two",
      "beta - [ ] three",
    ]);
  });

  it("a gate that answers no tx yields a result without one", async () => {
    const { dial, facet, doc } = await seeded();
    const admit = dial.admit.bind(dial);
    dial.admit = async (ops, scope) => {
      const r = await admit(ops, scope);
      return {
        admitted: r.admitted,
        minted: r.minted,
        violations: r.violations,
      };
    };
    const res = await patchContainer(facet, {
      container: doc,
      replacements: [{ find: "beta", replace: "gamma", expected_count: 1 }],
    });
    expect(res).not.toHaveProperty("tx");
    expect(res).toMatchObject({ noop: false });
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

describe("write_container with replacements", () => {
  it("patches the text, reports the tx, and reconciles the inline tags", async () => {
    const { mcp, tags, node } = await rig();
    expect((await tags.byNode(node)).map((r) => r.tag)).toEqual([
      "#b",
      "#project",
    ]);
    const res = await mcp.callTool({
      name: "write_container",
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
      name: "write_container",
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
      name: "write_container",
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
      name: "write_container",
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
      name: "write_container",
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
      name: "write_container",
      arguments: {
        container: node,
        slot: "nope",
        replacements: [{ find: "a", replace: "b", expected_count: 0 }],
      },
    });
    expect(badSlot.isError).toBe(true);
    const empty = await mcp.callTool({
      name: "write_container",
      arguments: { container: node, replacements: [] },
    });
    expect(empty.isError).toBe(true);
  });

  it("a named slot patches that block only", async () => {
    const { mcp, node } = await rig();
    await mcp.callTool({
      name: "write_container",
      arguments: {
        container: node,
        ops: [{ op: "add", text: "second #b block", position: "a1" }],
      },
    });
    const read = await mcp.callTool({
      name: "read_container",
      arguments: { container: node },
    });
    const slots = (
      read.structuredContent as { blocks: { slot: string }[] }
    ).blocks.map((b) => b.slot);
    const res = await mcp.callTool({
      name: "write_container",
      arguments: {
        container: node,
        slot: slots[1],
        replacements: [{ find: "#b", replace: "#c", expected_count: 1 }],
      },
    });
    expect(res.isError).toBeFalsy();
    expect(
      (res.structuredContent as { slots_changed: string[] }).slots_changed,
    ).toEqual([slots[1]]);
  });

  it("every tenant is accepted by name", async () => {
    const { mcp, node } = await rig();
    for (const tenant of ["notes", "documents", "comments", "governance"]) {
      const res = await mcp.callTool({
        name: "write_container",
        arguments: {
          container: node,
          tenant,
          replacements: [{ find: "absent", replace: "x", expected_count: 0 }],
        },
      });
      expect(res.isError, tenant).toBeFalsy();
    }
  });

  it("refuses a container or slot token with junk around the 64 hex", async () => {
    const { mcp, node } = await rig();
    const r = [{ find: "a", replace: "b", expected_count: 0 }];
    for (const args of [
      { container: `x${node}`, replacements: r },
      { container: `${node}x`, replacements: r },
      { container: node, slot: `x${"1".repeat(64)}`, replacements: r },
      { container: node, slot: `${"1".repeat(64)}x`, replacements: r },
    ]) {
      const res = await mcp.callTool({
        name: "write_container",
        arguments: args,
      });
      expect(res.isError, JSON.stringify(args)).toBe(true);
      // Refused at the schema, before the handler: a handler miss
      // (empty_container / bad_slot) would carry structured content.
      expect(res.structuredContent, JSON.stringify(args)).toBeUndefined();
    }
  });

  it("refuses both payloads, neither, and a slot with ops", async () => {
    const { mcp, node } = await rig();
    const r = [{ find: "#b", replace: "#c", expected_count: 1 }];
    const ops = [{ op: "add", text: "x", position: "b0" }];
    const both = "send exactly one of ops or replacements";
    const slotted = "slot applies only to replacements";
    const cases: [Record<string, unknown>, string][] = [
      [{ container: node, ops, replacements: r }, both],
      [{ container: node }, both],
      [{ container: node, ops, slot: "1".repeat(64) }, slotted],
    ];
    for (const [args, detail] of cases) {
      const res = await mcp.callTool({
        name: "write_container",
        arguments: args,
      });
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(res.structuredContent).toEqual({ error: "bad_arguments", detail });
      expect(res.content).toEqual([
        { type: "text", text: `bad_arguments: ${detail}` },
      ]);
    }
    // Nothing was written: the one block still reads as seeded.
    const read = await mcp.callTool({
      name: "read_container",
      arguments: { container: node },
    });
    expect(
      (read.structuredContent as { blocks: { text: string }[] }).blocks.map(
        (b) => b.text,
      ),
    ).toEqual(["uses #project and #b here"]);
  });

  it("a handler miss (empty_container) is structured", async () => {
    const { mcp } = await rig();
    const res = await mcp.callTool({
      name: "write_container",
      arguments: {
        container: "9".repeat(64),
        replacements: [{ find: "a", replace: "b", expected_count: 0 }],
      },
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as Out).error).toBe("empty_container");
  });

  it("the ops path still saves, nets out, and reconciles tags", async () => {
    const { mcp, tags, node } = await rig();
    const res = await mcp.callTool({
      name: "write_container",
      arguments: {
        container: node,
        ops: [{ op: "add", text: "more #c", position: "b0" }],
      },
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([{ type: "text", text: "applied 1 op(s)" }]);
    expect((res.structuredContent as Out).tags).toEqual({
      added: ["#c"],
      removed: [],
    });
    expect((await tags.byNode(node)).map((t) => t.tag)).toContain("#c");
  });

  it("publishes a short description and both payloads", async () => {
    const { mcp } = await rig();
    const { tools } = await mcp.listTools();
    expect(tools.find((t) => t.name === "patch_container")).toBeUndefined();
    const tool = tools.find((t) => t.name === "write_container");
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(tool?.title).toBe("Write a container (one graph transaction)");
    expect(tool?.description?.length).toBeLessThan(400);
    expect(tool?.description).toContain("EITHER ops");
    expect(tool?.description).toContain("count_mismatch");
    const schema = tool?.inputSchema as {
      properties: Record<string, { description?: string; enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "container",
      "ops",
      "replacements",
      "slot",
      "tenant",
    ]);
    expect(schema.required).toEqual(["container"]);
    expect(schema.properties.tenant?.enum).toEqual([
      "notes",
      "documents",
      "comments",
      "governance",
      "issues",
    ]);
  });
});
