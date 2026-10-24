/**
 * Threads as containers — the `threads` tenant, slot facts on write_container
 * and the facts read, and move_blocks (fixture dial, through a real MCP
 * client where the verb surface matters).
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureBlobStore } from "../src/blob-store.js";
import {
  FixtureChaosDial,
  TENANTS,
  opCreate,
  tenantScope,
} from "../src/chaos-client.js";
import { containerHistory, readContainer } from "../src/container-read.js";
import { moveBlocks } from "../src/container-move.js";
import { writeContainer } from "../src/container-write.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { createServer } from "../src/mcp/server.js";
import { SlotFactError } from "../src/slot-facts.js";
import { readTree } from "../src/tree.js";

const QUOTE = JSON.stringify({
  session_uuid: "u-1",
  seq: 3,
  ts: "2026-10-24T01:02:03-04:00",
  sha: "abc",
});
const sha = (t: string): string =>
  createHash("sha256").update(t, "utf8").digest("hex");

async function rig() {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const facet = { blobs, dial };
  const mint = async (label: string): Promise<string> => {
    const r = await dial.admit([opCreate("Note", label)], "threads");
    return r.minted[0] ?? "";
  };
  const server = createServer(new FixtureBodyClient(), {
    containers: facet,
  });
  const mcp = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return { dial, blobs, facet, mint, mcp };
}

interface Result {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}
async function call(mcp: Client, name: string, args: Record<string, unknown>) {
  return (await mcp.callTool({ name, arguments: args })) as Result;
}

describe("the threads tenant", () => {
  it("is a tenant with its own scope and env override", () => {
    expect(TENANTS).toContain("threads");
    expect(tenantScope("threads", {})).toBe("threads");
    expect(tenantScope("threads", { CALLIOPE_THREADS_SCOPE: "t2" })).toBe("t2");
  });

  it("write_container admits to the threads scope", async () => {
    const { mcp, mint, dial } = await rig();
    const c = await mint("thread");
    const res = await call(mcp, "write_container", {
      container: c,
      tenant: "threads",
      ops: [{ op: "add", text: "what_why", position: "a0" }],
    });
    expect(res.isError).toBeFalsy();
    expect(dial.admits.at(-1)?.scope).toBe("threads");
  });
});

describe("slot facts", () => {
  it("land in the same batch as the slot and read back with their form", async () => {
    const { mcp, mint, dial } = await rig();
    const c = await mint("thread");
    const persona = "a".repeat(64);
    const before = dial.admits.length;
    const res = await call(mcp, "write_container", {
      container: c,
      tenant: "threads",
      ops: [
        {
          op: "add",
          text: "narrative",
          position: "a0",
          facts: [
            { predicate: "authoredBy", node: persona },
            { predicate: "writtenIn", literal: "sess-uuid" },
            { predicate: "fromCheckpoint", literal: "42" },
            { predicate: "quotes", literal: "sess-uuid#7" },
            { predicate: "quotes", literal: "sess-uuid#9" },
            { predicate: "links", literal: "https://example.test/x" },
            { predicate: "writtenAt", literal: "2026-10-24T01:02:03Z" },
            { predicate: "authorKind", literal: "ai" },
            { predicate: "contentHash", literal: sha("narrative") },
            { predicate: "signedAs", literal: "Scotty36" },
            { predicate: "inSeat", literal: "calliope" },
            { predicate: "legacyId", literal: "1316" },
            { predicate: "authored", literal: "b/two.md" },
            { predicate: "authored", literal: "b/one.md" },
            { predicate: "quotes", literal: QUOTE },
          ],
        },
      ],
    });
    expect(res.isError).toBeFalsy();
    expect(dial.admits.length).toBe(before + 1); // ONE batch

    const read = await call(mcp, "read_container", {
      container: c,
      facts: true,
    });
    const blocks = read.structuredContent?.blocks as {
      facts: { predicate: string; form: string; value: string }[];
    }[];
    const facts = blocks[0]?.facts ?? [];
    const by = (p: string) => facts.filter((f) => f.predicate === p);
    expect(by("authoredBy")).toEqual([
      { predicate: "authoredBy", form: "node", value: persona },
    ]);
    expect(by("writtenIn")[0]).toMatchObject({
      form: "literal",
      value: "sess-uuid",
    });
    expect(by("quotes").map((f) => f.value)).toEqual([
      "sess-uuid#7",
      "sess-uuid#9",
      QUOTE,
    ]);
    expect(by("contentHash")[0]?.value).toBe(sha("narrative"));
    expect(by("writtenAt")).toHaveLength(1);
    expect(by("signedAs")[0]?.value).toBe("Scotty36");
    expect(by("inSeat")[0]?.value).toBe("calliope");
    expect(by("legacyId")[0]?.value).toBe("1316");
    // Repeatables read back sorted by value (deterministic), not write order.
    expect(by("authored").map((f) => f.value)).toEqual([
      "b/one.md",
      "b/two.md",
    ]);
    expect(by("quotes").map((f) => f.value)).toContain(QUOTE);
    expect(JSON.parse(by("quotes").at(-1)?.value ?? "{}")).toMatchObject({
      session_uuid: "u-1",
      seq: 3,
    });

    // Off by default; as-of and batch reads agree.
    const plain = await call(mcp, "read_container", { container: c });
    expect(
      (plain.structuredContent?.blocks as Record<string, unknown>[])[0],
    ).not.toHaveProperty("facts");
    const batch = await call(mcp, "read_containers", {
      containers: [c],
      facts: true,
    });
    const bfacts = (
      batch.structuredContent?.containers as {
        blocks: { facts: unknown[] }[];
      }[]
    )[0]?.blocks[0]?.facts;
    expect(bfacts).toHaveLength(facts.length);
    const asOf = await call(mcp, "read_container", {
      container: c,
      facts: true,
      as_of_tx: dial.admits.length,
    });
    const afacts = (asOf.structuredContent?.blocks as { facts: unknown[] }[])[0]
      ?.facts;
    expect(afacts).toHaveLength(facts.length);
  });

  it("computes contentHash when none is sent", async () => {
    const { facet, mint } = await rig();
    const c = await mint("t");
    await writeContainer(
      facet,
      c,
      [
        {
          op: "add",
          text: "words",
          position: "a0",
          facts: [{ predicate: "contentHash" }],
        },
      ],
      "threads",
    );
    const r = await readContainer(facet, c, { facts: true });
    expect(r.blocks[0]?.facts).toEqual([
      { predicate: "contentHash", form: "literal", value: sha("words") },
    ]);
  });

  it("refuses a contentHash mismatch, writing nothing", async () => {
    const { mcp, mint, dial, blobs } = await rig();
    const c = await mint("t");
    const admits = dial.admits.length;
    const res = await call(mcp, "write_container", {
      container: c,
      tenant: "threads",
      ops: [
        {
          op: "add",
          text: "x",
          position: "a0",
          facts: [{ predicate: "contentHash", literal: "0".repeat(64) }],
        },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.code).toBe("bad_args");
    expect(dial.admits.length).toBe(admits);
    expect(blobs.size).toBe(0);
  });

  it("refuses a predicate outside the allow-list", async () => {
    const { mcp, mint, dial } = await rig();
    const c = await mint("t");
    const admits = dial.admits.length;
    const res = await mcp.callTool({
      name: "write_container",
      arguments: {
        container: c,
        ops: [
          {
            op: "add",
            text: "x",
            position: "a0",
            facts: [{ predicate: "tree_member", node: "b".repeat(64) }],
          },
        ],
      },
    });
    expect((res as Result).isError).toBe(true);
    expect((res as Result).structuredContent?.code).toBe("bad_args");
    expect(dial.admits.length).toBe(admits);
  });

  it("refuses shape errors: both/neither target, node on a literal-only predicate", async () => {
    const { facet, mint } = await rig();
    const c = await mint("t");
    const w = (facts: object[]) =>
      writeContainer(facet, c, [
        { op: "add", text: "x", position: "a0", facts: facts as never },
      ]);
    await expect(
      w([{ predicate: "authoredBy", node: "a".repeat(64), literal: "x" }]),
    ).rejects.toBeInstanceOf(SlotFactError);
    await expect(w([{ predicate: "authoredBy" }])).rejects.toBeInstanceOf(
      SlotFactError,
    );
    await expect(
      w([{ predicate: "authorKind", node: "a".repeat(64) }]),
    ).rejects.toBeInstanceOf(SlotFactError);
    await expect(
      w([{ predicate: "authoredBy", node: "not-hex" }]),
    ).rejects.toBeInstanceOf(SlotFactError);
    await expect(
      w([
        { predicate: "authoredBy", literal: "a" },
        { predicate: "authoredBy", literal: "b" },
      ]),
    ).rejects.toBeInstanceOf(SlotFactError);
    await expect(
      w([{ predicate: "legacyId", literal: "12x" }]),
    ).rejects.toBeInstanceOf(SlotFactError);
    await expect(
      w([{ predicate: "quotes", literal: '{"seq":1}' }]),
    ).rejects.toBeInstanceOf(SlotFactError);
  });

  it("an update replaces contentHash and may add quotes; identity facts are refused", async () => {
    const { facet, mint } = await rig();
    const c = await mint("t");
    await writeContainer(facet, c, [
      {
        op: "add",
        text: "v1",
        position: "a0",
        facts: [{ predicate: "contentHash" }],
      },
    ]);
    const [slot] = await readTree(facet.dial, c);
    if (slot?.blobId == null) throw new Error("no slot");
    await expect(
      writeContainer(facet, c, [
        {
          op: "update",
          slot: slot.slot,
          oldBlobId: slot.blobId,
          text: "v2",
          facts: [{ predicate: "authoredBy", literal: "x" }],
        },
      ]),
    ).rejects.toBeInstanceOf(SlotFactError);
    await writeContainer(facet, c, [
      {
        op: "update",
        slot: slot.slot,
        oldBlobId: slot.blobId,
        text: "v2",
        facts: [
          { predicate: "contentHash" },
          { predicate: "quotes", literal: "s#1" },
        ],
      },
    ]);
    const r = await readContainer(facet, c, { facts: true });
    expect(r.blocks[0]?.text).toBe("v2");
    expect(r.blocks[0]?.facts).toEqual([
      { predicate: "quotes", form: "literal", value: "s#1" },
      { predicate: "contentHash", form: "literal", value: sha("v2") },
    ]);
  });
});

describe("move_blocks", () => {
  async function two() {
    const r = await rig();
    const from = await r.mint("from");
    const to = await r.mint("to");
    await writeContainer(
      r.facet,
      from,
      ["f0", "f1", "f2", "f3"].map((t, i) => ({
        op: "add" as const,
        text: t,
        position: `0${String(i + 1)}`,
        facts: [{ predicate: "authorKind" as const, literal: "ai" }],
      })),
      "threads",
    );
    await writeContainer(
      r.facet,
      to,
      ["t0", "t1"].map((t, i) => ({
        op: "add" as const,
        text: t,
        position: `0${String((i + 1) * 3)}`,
      })),
      "threads",
    );
    return { ...r, from, to };
  }
  const texts = async (
    facet: Awaited<ReturnType<typeof rig>>["facet"],
    c: string,
  ) => (await readContainer(facet, c)).blocks.map((b) => b.text);

  it("moves slots contiguous, in original relative order, to the end", async () => {
    const { facet, from, to, mcp } = await two();
    const src = await readTree(facet.dial, from);
    const pick = [src[2], src[0]].map((s) => s?.slot ?? ""); // asked out of order
    const res = await call(mcp, "move_blocks", {
      from,
      to,
      slots: pick,
      tenant: "threads",
    });
    expect(res.isError).toBeFalsy();
    expect(await texts(facet, to)).toEqual(["t0", "t1", "f0", "f2"]);
    expect(await texts(facet, from)).toEqual(["f1", "f3"]);
  });

  it("moves to the start and after a named slot", async () => {
    const { facet, from, to } = await two();
    const src = await readTree(facet.dial, from);
    const dst = await readTree(facet.dial, to);
    await moveBlocks(
      facet,
      { from, to, slots: [src[1]?.slot ?? ""], position: "start" },
      "threads",
    );
    await moveBlocks(
      facet,
      {
        from,
        to,
        slots: [src[0]?.slot ?? "", src[3]?.slot ?? ""],
        position: dst[0]?.slot ?? "",
      },
      "threads",
    );
    expect(await texts(facet, to)).toEqual(["f1", "t0", "f0", "f3", "t1"]);
    expect(await texts(facet, from)).toEqual(["f2"]);
  });

  it("keeps slot token, blob and facts", async () => {
    const { facet, from, to } = await two();
    const [slot] = await readTree(facet.dial, from);
    await moveBlocks(facet, { from, to, slots: [slot?.slot ?? ""] }, "threads");
    const moved = (await readContainer(facet, to, { facts: true })).blocks.find(
      (b) => b.slot === slot?.slot,
    );
    expect(moved?.blobId).toBe(slot?.blobId);
    expect(moved?.facts).toEqual([
      { predicate: "authorKind", form: "literal", value: "ai" },
    ]);
  });

  it("refuses the whole batch when a slot is not a member of from", async () => {
    const { facet, from, to, dial } = await two();
    const [a] = await readTree(facet.dial, from);
    const [stray] = await readTree(facet.dial, to);
    const admits = dial.admits.length;
    await expect(
      moveBlocks(
        facet,
        { from, to, slots: [a?.slot ?? "", stray?.slot ?? ""] },
        "threads",
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(dial.admits.length).toBe(admits);
    expect(await texts(facet, from)).toHaveLength(4);
  });

  it("refuses same-container, repeats, empty and a bad anchor", async () => {
    const { facet, from, to } = await two();
    const [a] = await readTree(facet.dial, from);
    const s = a?.slot ?? "";
    for (const args of [
      { from, to: from, slots: [s] },
      { from, to, slots: [s, s] },
      { from, to, slots: [] },
      { from, to, slots: [s], position: "middle" },
      { from, to, slots: [s], position: "c".repeat(64) },
    ]) {
      await expect(moveBlocks(facet, args, "threads")).rejects.toBeDefined();
    }
    expect(await texts(facet, from)).toHaveLength(4);
  });

  it("refuses when the source changed after it was read (conflict)", async () => {
    const { facet, from, to, dial } = await two();
    const [a] = await readTree(facet.dial, from);
    const realAdmit = dial.admit.bind(dial);
    dial.admit = async (ops, scope, expect) => {
      // A concurrent writer lands between the read and the batch.
      dial.admit = realAdmit;
      await writeContainer(facet, from, [
        { op: "add", text: "late", position: "09" },
      ]);
      return realAdmit(ops, scope, expect);
    };
    await expect(
      moveBlocks(facet, { from, to, slots: [a?.slot ?? ""] }, "threads"),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await texts(facet, to)).toEqual(["t0", "t1"]);
  });

  it("history reaches a moved slot from BOTH containers", async () => {
    const { facet, from, to } = await two();
    const [a] = await readTree(facet.dial, from);
    const slot = a?.slot ?? "";
    // A post-move edit of the slot's text lands on the slot only.
    const { tx } = await moveBlocks(
      facet,
      { from, to, slots: [slot] },
      "threads",
    );
    await writeContainer(facet, to, [
      {
        op: "update",
        slot,
        oldBlobId: a?.blobId ?? "",
        text: "f0 revised",
      },
    ]);
    const slotTxs = (h: { tx: number }[]) => h.map((e) => e.tx);
    const inFrom = slotTxs(await containerHistory(facet, from));
    const inTo = slotTxs(await containerHistory(facet, to));
    const edit = Math.max(...inTo);
    expect(inFrom[0]).toBeLessThan(tx ?? 0); // the births precede the move
    expect(inFrom).toContain(tx);
    expect(inTo).toContain(tx);
    expect(inFrom).toContain(edit); // the edit, via the ever-held closure
  });
});
