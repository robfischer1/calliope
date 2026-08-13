/**
 * F4 (026) — the comment verbs over the MCP surface (fixture-backed).
 *
 * `create_comment` + `list_comments` are the caller surface of the
 * commentsOn edge. A comment REQUIRES a session-principal author (TURN
 * 258); creation is atomic; threads resolve both ways and follow the
 * target's lineage.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCalliopeHttpServer } from "../src/mcp/http.js";

let server: Server;
let base: string;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

const PRINCIPAL =
  "spiffe://notusmi.com/session/aa579121-1a2b-4c3d-8e4f-a5b6c7d8e9f0";

async function rpc(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const resp = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  const ct = resp.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const line = text
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("data:"));
    return JSON.parse(
      (line ?? "data:{}").slice("data:".length).trim(),
    ) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

let rpcId = 500;

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; structured?: unknown; raw: unknown }> {
  const resp = (await rpc({
    jsonrpc: "2.0",
    id: rpcId++,
    method: "tools/call",
    params: { name, arguments: args },
  })) as {
    result?: { isError?: boolean; structuredContent?: unknown };
    error?: { message?: string };
  };
  return {
    isError: resp.result?.isError ?? resp.error !== undefined,
    structured: resp.result?.structuredContent,
    raw: resp,
  };
}

async function seedBlock(container: string, text: string): Promise<string> {
  const created = await call("create_block", {
    container_id: container,
    text,
  });
  return (created.structured as { block: { id: string } }).block.id;
}

interface ThreadShape {
  targetId: string;
  targetState: string;
  comments: { id: string; text: string; author: string; commentsOn: string }[];
}

async function threadsOf(
  container: string,
  blockId?: string,
): Promise<ThreadShape[]> {
  const res = await call("list_comments", {
    container_id: container,
    ...(blockId === undefined ? {} : { block_id: blockId }),
  });
  return (res.structured as { threads: ThreadShape[] }).threads;
}

beforeEach(async () => {
  server = createCalliopeHttpServer("fixture");
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${String(addr.port)}`;
  await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    },
  });
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

describe("026 — create_comment / list_comments", () => {
  it("creates and reads back both ways, attributed", async () => {
    const target = await seedBlock("m1", "the block under review");
    const made = await call("create_comment", {
      container_id: "m1",
      target_block_id: target,
      text: "this drifted from the plan",
      authored_by: PRINCIPAL,
      kafka_offset: 42,
    });
    expect(made.isError).toBeFalsy();
    const shaped = made.structured as {
      comment: { id: string };
      target_id: string;
      comment_container_id: string;
    };
    expect(shaped.target_id).toBe(target);
    expect(shaped.comment_container_id).toBe("m1#comments");

    const focused = await threadsOf("m1", target);
    expect(focused).toHaveLength(1);
    expect(focused[0]?.comments.map((c) => c.text)).toEqual([
      "this drifted from the plan",
    ]);
    expect(focused[0]?.comments[0]?.author).toBe(PRINCIPAL);
    expect(focused[0]?.comments[0]?.commentsOn).toBe(target);

    const all = await threadsOf("m1");
    expect(all.map((t) => t.targetId)).toEqual([target]);
  });

  it("rejects a missing or non-session author naming the rule — nothing lands", async () => {
    const target = await seedBlock("m2", "block");
    const missing = await call("create_comment", {
      container_id: "m2",
      target_block_id: target,
      text: "anon",
    });
    expect(missing.isError).toBe(true);
    const legacy = await call("create_comment", {
      container_id: "m2",
      target_block_id: target,
      text: "still anon",
      authored_by: "human",
    });
    expect(legacy.isError).toBe(true);
    expect(JSON.stringify(legacy.raw)).toMatch(/session/);
    expect(await threadsOf("m2")).toEqual([]);
  });

  it("rejects a stale target", async () => {
    await seedBlock("m3", "block");
    const res = await call("create_comment", {
      container_id: "m3",
      target_block_id: "no-such-block",
      text: "x",
      authored_by: PRINCIPAL,
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.raw)).toMatch(/stale/);
  });

  it("027: resolve_anchors returns anchor, current, and drift over the wire", async () => {
    const target = await seedBlock("m5", "v1 wire");
    await call("create_comment", {
      container_id: "m5",
      target_block_id: target,
      text: "about v1",
      authored_by: PRINCIPAL,
    });
    await call("update_block", {
      container_id: "m5",
      block_id: target,
      text: "v2 wire",
    });

    const anchored = await call("list_comments", {
      container_id: "m5",
      resolve_anchors: true,
    });
    const rec = (
      anchored.structured as {
        threads: {
          comments: {
            anchorText?: string | null;
            currentText?: string | null;
            drift?: boolean;
          }[];
        }[];
      }
    ).threads[0]?.comments[0];
    expect(rec?.anchorText).toBe("v1 wire");
    expect(rec?.currentText).toBe("v2 wire");
    expect(rec?.drift).toBe(true);

    const plain = await call("list_comments", { container_id: "m5" });
    const plainRec = (plain.structured as { threads: { comments: object[] }[] })
      .threads[0]?.comments[0];
    expect(plainRec !== undefined && "drift" in plainRec).toBe(false);
  });

  it("replies thread and an edited target keeps its trail", async () => {
    const target = await seedBlock("m4", "v1");
    const parent = await call("create_comment", {
      container_id: "m4",
      target_block_id: target,
      text: "parent",
      authored_by: PRINCIPAL,
    });
    const parentId = (parent.structured as { comment: { id: string } }).comment
      .id;
    await call("create_comment", {
      container_id: "m4",
      target_block_id: parentId,
      text: "reply",
      authored_by: PRINCIPAL,
    });

    const updated = await call("update_block", {
      container_id: "m4",
      block_id: target,
      text: "v2",
    });
    const newId = (updated.structured as { block: { id: string } }).block.id;

    const thread = await threadsOf("m4", newId);
    expect(thread[0]?.comments.map((c) => c.text)).toEqual(["parent"]);
    const replyThread = await threadsOf("m4", parentId);
    expect(replyThread[0]?.comments.map((c) => c.text)).toEqual(["reply"]);
  });
});
