/**
 * Transclusion over the MCP surface (Lamarr37-002): the wire codes, the
 * delete_note purge guard, and the fan-out that republishes every container
 * reading an edited origin.
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
  publish(projection: NoteProjection): Promise<boolean> {
    this.published.push(projection);
    return Promise.resolve(true);
  }
  retract(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

interface Block {
  slot: string;
  position: string;
  blobId: string | null;
  text: string | null;
  dangling: boolean;
  ref?: { slot: string; container?: string };
  placements?: { slot: string; container?: string }[];
}

async function rig() {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const tags = new FixtureTagStore();
  const publisher = new RecordingPublisher();
  const server = createServer(new FixtureBodyClient(), {
    chaos: { dial, scope: "notes" },
    containers: { blobs, dial },
    tags,
    consciousness: publisher,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await mcp.callTool({ name, arguments: args });
    if (res.isError === true) {
      return {
        error: res.structuredContent as { code: string; detail: string },
      };
    }
    return { ok: res.structuredContent as Record<string, unknown> };
  };
  const note = async (title: string): Promise<string> => {
    const r = await call("create_note", { title });
    return (r.ok as { node_id: string }).node_id;
  };
  const write = (container: string, ops: unknown[], tenant?: string) =>
    call("write_container", {
      container,
      ops,
      ...(tenant !== undefined ? { tenant } : {}),
    });
  const blocks = async (
    container: string,
    extra: Record<string, unknown> = {},
  ): Promise<Block[]> =>
    (
      (await call("read_container", { container, ...extra })).ok as {
        blocks: Block[];
      }
    ).blocks;
  /** A note with one block; answers [note, slot]. */
  const withBlock = async (title: string, text: string) => {
    const n = await note(title);
    const w = await write(n, [{ op: "add", text, position: "a0" }]);
    const minted = (w.ok as { minted: Record<string, string> }).minted;
    return [n, minted["0"] ?? ""] as const;
  };
  const place = async (container: string, origin: string) => {
    const w = await write(container, [
      { op: "add", ref: origin, position: "b0" },
    ]);
    expect(w.error).toBeUndefined();
    return (w.ok as { minted: Record<string, string> }).minted["0"] ?? "";
  };
  return {
    dial,
    mcp,
    publisher,
    call,
    note,
    write,
    blocks,
    withBlock,
    place,
  };
}

describe("write_container's transclusion wire", () => {
  it("an add sends exactly one of text or ref (bad_args otherwise)", async () => {
    const r = await rig();
    const [, origin] = await r.withBlock("a", "x");
    const b = await r.note("b");
    const both = await r.write(b, [
      { op: "add", text: "t", ref: origin, position: "a0" },
    ]);
    expect(both.error?.code).toBe("bad_args");
    const neither = await r.write(b, [{ op: "add", position: "a0" }]);
    expect(neither.error?.code).toBe("bad_args");
  });

  it("a ref naming no slot with content refuses not_found, with the detail", async () => {
    const r = await rig();
    const b = await r.note("b");
    const res = await r.write(b, [
      { op: "add", ref: "9".repeat(64), position: "a0" },
    ]);
    expect(res.error).toEqual({
      code: "not_found",
      detail: `write_container: ref ${"9".repeat(64)} names no slot holding content`,
    });
  });

  it("a placement of a placement refuses bad_args (chains are refused)", async () => {
    const r = await rig();
    const [, origin] = await r.withBlock("a", "x");
    const b = await r.note("b");
    const p = await r.place(b, origin);
    const c = await r.note("c");
    const res = await r.write(c, [{ op: "add", ref: p, position: "a0" }]);
    expect(res.error?.code).toBe("bad_args");
    expect(res.error?.detail).toContain("chains are refused");
  });

  it("a placement reads the origin's text, and placements: true lists it", async () => {
    const r = await rig();
    const [a, origin] = await r.withBlock("a", "shared words");
    const b = await r.note("b");
    const p = await r.place(b, origin);
    const [got] = await r.blocks(b);
    expect(got).toMatchObject({
      slot: p,
      text: "shared words",
      dangling: false,
      ref: { slot: origin, container: a },
    });
    const [src] = await r.blocks(a, { placements: true });
    expect(src?.placements).toEqual([{ slot: p, container: b }]);
    const m = await r.call("materialize_note", { container_id: b });
    expect(JSON.stringify(m.ok)).toContain("shared words");
  });

  it("a cross-tenant placement refuses cross_tenant_placement by default", async () => {
    const r = await rig();
    const [, origin] = await r.withBlock("memo", "notes prose");
    const law = await r.note("law");
    const res = await r.write(
      law,
      [{ op: "add", ref: origin, position: "a0" }],
      "governance",
    );
    expect(res.error?.code).toBe("cross_tenant_placement");
  });

  it("removing a placed origin refuses has_placements; orphan answers orphaned", async () => {
    const r = await rig();
    const [a, origin] = await r.withBlock("a", "src");
    const b = await r.note("b");
    const p = await r.place(b, origin);
    const [src] = await r.blocks(a);
    const op = {
      op: "remove",
      slot: origin,
      position: src?.position,
      blobId: src?.blobId,
    };
    const refused = await r.write(a, [op]);
    expect(refused.error?.code).toBe("has_placements");
    const done = await r.write(a, [{ ...op, placements: "orphan" }]);
    expect(done.ok?.orphaned).toEqual([{ slot: p, container: b, origin }]);
    const [left] = await r.blocks(b);
    expect(left).toMatchObject({ slot: p, dangling: true, text: null });
    expect(left?.ref?.slot).toBe(origin);
  });
});

describe("an origin edit fans out to every container reading it", () => {
  it("an edit through a placement republishes the origin's note and the other placements'", async () => {
    const r = await rig();
    const [a, origin] = await r.withBlock("a", "fan v1");
    const b = await r.note("b");
    const c = await r.note("c");
    const pb = await r.place(b, origin);
    await r.place(c, origin);
    const [seen] = await r.blocks(b);
    r.publisher.published = [];
    const w = await r.write(b, [
      { op: "update", slot: pb, oldBlobId: seen?.blobId, text: "fan v2" },
    ]);
    expect(w.ok?.routed).toEqual({ "0": origin });
    const nodes = r.publisher.published.map((p) => p.node).sort();
    expect(nodes).toEqual([a, b, c].sort());
    expect(r.publisher.published.every((p) => p.body.includes("fan v2"))).toBe(
      true,
    );
  });

  it("a direct edit of an origin republishes its placements' notes", async () => {
    const r = await rig();
    const [a, origin] = await r.withBlock("a", "direct v1");
    const b = await r.note("b");
    await r.place(b, origin);
    const [src] = await r.blocks(a);
    r.publisher.published = [];
    await r.write(a, [
      { op: "update", slot: origin, oldBlobId: src?.blobId, text: "direct v2" },
    ]);
    expect(r.publisher.published.map((p) => p.node).sort()).toEqual(
      [a, b].sort(),
    );
  });

  it("an edit to a block nobody places publishes only its own note", async () => {
    const r = await rig();
    const [a, slot] = await r.withBlock("a", "alone");
    const [src] = await r.blocks(a);
    r.publisher.published = [];
    await r.write(a, [
      { op: "update", slot, oldBlobId: src?.blobId, text: "alone 2" },
    ]);
    expect(r.publisher.published.map((p) => p.node)).toEqual([a]);
  });
});

describe("delete_note purge honours placements", () => {
  it("purging a note whose block is placed elsewhere refuses has_placements", async () => {
    const r = await rig();
    const [a, origin] = await r.withBlock("a", "kept alive");
    const b = await r.note("b");
    await r.place(b, origin);
    const res = await r.call("delete_note", {
      ids: [a],
      purge: true,
      dry_run: false,
    });
    expect(res.error?.code).toBe("batch_refused");
    expect(res.error?.detail).toContain("has_placements");
    const [still] = await r.blocks(b);
    expect(still?.text).toBe("kept alive");
  });

  it('placements: "orphan" purges it; the placement dangles, its ref kept', async () => {
    const r = await rig();
    const [a, origin] = await r.withBlock("a", "going away");
    const b = await r.note("b");
    const p = await r.place(b, origin);
    const res = await r.call("delete_note", {
      ids: [a],
      purge: true,
      dry_run: false,
      placements: "orphan",
    });
    expect(res.error).toBeUndefined();
    const notes = (res.ok as { notes: { orphaned?: unknown[] }[] }).notes;
    expect(notes[0]?.orphaned).toEqual([{ slot: p, container: b, origin }]);
    const [left] = await r.blocks(b);
    expect(left).toMatchObject({ slot: p, dangling: true, text: null });
    expect(left?.ref?.slot).toBe(origin);
  });

  it("purging the origin and its placements together needs no flag", async () => {
    const r = await rig();
    const [a, origin] = await r.withBlock("a", "together");
    const b = await r.note("b");
    await r.place(b, origin);
    const res = await r.call("delete_note", {
      ids: [a, b],
      purge: true,
      dry_run: false,
    });
    expect(res.error).toBeUndefined();
  });
});

describe("read_container's placements flag", () => {
  it("is off unless asked: a placed origin lists no placements by default", async () => {
    const r = await rig();
    const [a, origin] = await r.withBlock("a", "src");
    const b = await r.note("b");
    await r.place(b, origin);
    const [plain] = await r.blocks(a);
    expect(plain?.placements).toBeUndefined();
    const [asked] = await r.blocks(a, { placements: true });
    expect(asked?.placements).toHaveLength(1);
    const { tools } = await r.mcp.listTools();
    const read = tools.find((t) => t.name === "read_container");
    const props = read?.inputSchema.properties as Record<
      string,
      { default?: unknown; description?: string }
    >;
    expect(props.placements?.default).toBe(false);
    expect(props.placements?.description).toBe(
      "Also answer each block's placements: the slots (and their " +
        "containers) that reference it — the reverse index of ref.",
    );
  });

  it("publishes its description, naming how a placement reads", async () => {
    const r = await rig();
    const { tools } = await r.mcp.listTools();
    const read = tools.find((t) => t.name === "read_container");
    expect(read?.description).toBe(
      "042 F5 (Git for Ideas): resolve a container's tree and fetch its " +
        "prose in ONE batched blob lookup — blocks in position order. " +
        "as_of_tx reads the container as it stood at that transaction " +
        "(members since removed included). A tree fact naming an absent " +
        "blob surfaces as dangling (text null) — reported, never " +
        "fabricated. A placement block (one that references another " +
        "slot) carries ref {slot, container} and reads its origin's blobId " +
        "and text, as of the same transaction; an orphaned placement is " +
        "dangling with ref kept.",
    );
  });
});

describe("write_container's published op schema", () => {
  const described = (node: unknown, out: Set<string> = new Set()) => {
    if (Array.isArray(node)) {
      for (const n of node) described(n, out);
    } else if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "description" && typeof v === "string") out.add(v);
        else described(v, out);
      }
    }
    return out;
  };

  it("describes every op and its operands", async () => {
    const r = await rig();
    const { tools } = await r.mcp.listTools();
    const write = tools.find((t) => t.name === "write_container");
    const props = write?.inputSchema.properties as Record<string, unknown>;
    const all = described(props.ops);
    for (const want of [
      "Add a block: send text (a new blob) OR ref (a placement of " +
        "an existing block), exactly one.",
      "Place an existing block instead of new text: the origin " +
        "slot's 64-hex token. Reads resolve through it; an edit " +
        "through the placement rewrites the origin, so every " +
        "placement changes. The origin must hold content (not_found " +
        "otherwise; a placement is refused bad_args: no chains). " +
        "Cross-tenant refuses cross_tenant_placement " +
        "(placement-policy.ts). No facts.",
      "Rewrite a block's prose. On a placement it rewrites the " +
        "origin (oldBlobId is the origin's, as read).",
      "Remove a block. On a placement only the placement goes; an " +
        "origin that still has placements refuses has_placements " +
        'unless placements is "orphan".',
      "The blob the slot holds now (a placement: its origin's, as " +
        'read; "" for a dangling placement).',
      "Removing an origin with placements: leave them dangling " +
        "(each keeps its ref and reads dangling).",
    ]) {
      expect(all.has(want), want).toBe(true);
    }
  });

  it("marks an add as needing exactly one of text or ref", async () => {
    const r = await rig();
    const { tools } = await r.mcp.listTools();
    const write = tools.find((t) => t.name === "write_container");
    const props = write?.inputSchema.properties as Record<string, unknown>;
    expect(JSON.stringify(props.ops)).toContain(
      '"x-requiredOneOf":[["text"],["ref"]]',
    );
  });
});
