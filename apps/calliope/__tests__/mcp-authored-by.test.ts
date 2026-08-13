/**
 * F1 (024) — the MCP boundary accepts, validates, and threads `authored_by`.
 *
 * Fixture-backed over a real socket (the mcp-http harness pattern). The nine
 * sections-writing verbs accept an optional `authored_by` — a legacy literal
 * or a SPIFFE session principal. Invalid values reject naming the accepted
 * forms and write nothing; absent values behave exactly as before 024.
 * (`coalesce_block_writes` is deliberately absent: it removes rows and stamps
 * no provenance — surfaced as a contract correction in the spec dir.)
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

let rpcId = 100;

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

/** Newest-first authors from read_body_revisions. */
async function revisionAuthors(nodeId: string): Promise<string[]> {
  const res = await call("read_body_revisions", { node_id: nodeId });
  const revs = (res.structured as { revisions?: { authoredBy: string }[] })
    .revisions;
  return (revs ?? []).map((r) => r.authoredBy);
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

describe("024 — authored_by on the write verbs (fixture-backed)", () => {
  it("create_block with a session principal lands and the revision reports it", async () => {
    const created = await call("create_block", {
      container_id: "n1",
      text: "session-authored block",
      authored_by: PRINCIPAL,
    });
    expect(created.isError).toBeFalsy();
    expect(await revisionAuthors("n1")).toEqual([PRINCIPAL]);
  });

  it("absent authored_by behaves exactly as before (default author)", async () => {
    await call("create_block", { container_id: "n2", text: "plain" });
    expect(await revisionAuthors("n2")).toEqual(["human"]);
  });

  it("legacy literals still validate on the wire", async () => {
    const a = await call("create_block", {
      container_id: "n3",
      text: "one",
      authored_by: "human",
    });
    const b = await call("create_block", {
      container_id: "n3",
      text: "two",
      authored_by: "calliope",
    });
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    expect(await revisionAuthors("n3")).toEqual(["calliope", "human"]);
  });

  it("an invalid author rejects naming the accepted forms and writes nothing", async () => {
    const res = await call("create_block", {
      container_id: "n4",
      text: "should not land",
      authored_by: "gandalf",
    });
    expect(res.isError).toBe(true);
    const msg = JSON.stringify(res.raw);
    expect(msg).toMatch(/human/);
    expect(msg).toMatch(/calliope/);
    expect(msg).toMatch(/spiffe:/);
    // Nothing was written: no revisions exist for n4.
    expect(await revisionAuthors("n4")).toEqual([]);
  });

  it("a workload (non-session) SPIFFE id is rejected", async () => {
    const res = await call("create_block", {
      container_id: "n5",
      text: "nope",
      authored_by: "spiffe://notusmi.com/workload/calliope",
    });
    expect(res.isError).toBe(true);
  });

  it("every remaining write verb threads the principal to its event", async () => {
    // Seed a body: two blocks via apply_section_ops under the principal.
    const seeded = await call("apply_section_ops", {
      node_id: "n6",
      ops: [
        { op: "add", text: "alpha", order_key: "a0" },
        { op: "add", text: "beta", order_key: "b0" },
      ],
      authored_by: PRINCIPAL,
    });
    expect(seeded.isError).toBeFalsy();

    const body = (
      (await call("read_body", { node_id: "n6" })).structured as {
        sections: { id: string; text: string }[];
      }
    ).sections;
    const alpha = body[0];
    if (!alpha) throw new Error("seed failed");

    // update_block
    const updated = await call("update_block", {
      container_id: "n6",
      block_id: alpha.id,
      text: "alpha edited",
      authored_by: PRINCIPAL,
    });
    expect(updated.isError).toBeFalsy();
    const updatedId = (updated.structured as { block: { id: string } }).block
      .id;

    // split_block
    const split = await call("split_block", {
      container_id: "n6",
      block_id: updatedId,
      offset: 5,
      authored_by: PRINCIPAL,
    });
    expect(split.isError).toBeFalsy();
    const [first, second] = (split.structured as { blocks: { id: string }[] })
      .blocks;
    if (!first || !second) throw new Error("split failed");

    // merge_block
    const merged = await call("merge_block", {
      container_id: "n6",
      first_block_id: first.id,
      second_block_id: second.id,
      authored_by: PRINCIPAL,
    });
    expect(merged.isError).toBeFalsy();
    const mergedId = (merged.structured as { block: { id: string } }).block.id;

    // delete_block
    const deleted = await call("delete_block", {
      container_id: "n6",
      block_id: mergedId,
      authored_by: PRINCIPAL,
    });
    expect(deleted.isError).toBeFalsy();

    // edit_section on the remaining block
    const rest = (
      (await call("read_body", { node_id: "n6" })).structured as {
        sections: { id: string }[];
      }
    ).sections;
    const beta = rest[0];
    if (!beta) throw new Error("beta vanished");
    const editedSec = await call("edit_section", {
      node_id: "n6",
      section_id: beta.id,
      text: "beta edited",
      authored_by: PRINCIPAL,
    });
    expect(editedSec.isError).toBeFalsy();

    // append_section + write_body
    const appended = await call("append_section", {
      node_id: "n6",
      text: "gamma",
      authored_by: PRINCIPAL,
    });
    expect(appended.isError).toBeFalsy();
    const written = await call("write_body", {
      node_id: "n6",
      sections: [{ text: "fresh start" }],
      authored_by: PRINCIPAL,
    });
    expect(written.isError).toBeFalsy();

    // Every event in the history carries the principal — none fell back.
    const authors = await revisionAuthors("n6");
    expect(authors.length).toBeGreaterThanOrEqual(8);
    expect(new Set(authors)).toEqual(new Set([PRINCIPAL]));
  });
});

describe("025 — kafka_offset on the write verbs (fixture-backed)", () => {
  async function revisionOffsets(nodeId: string): Promise<(number | null)[]> {
    const res = await call("read_body_revisions", { node_id: nodeId });
    const revs = (
      res.structured as { revisions?: { kafkaOffset: number | null }[] }
    ).revisions;
    return (revs ?? []).map((r) => r.kafkaOffset);
  }

  it("create_block with principal + offset lands and the revision reports the offset", async () => {
    const created = await call("create_block", {
      container_id: "o1",
      text: "stamped block",
      authored_by: PRINCIPAL,
      kafka_offset: 1234,
    });
    expect(created.isError).toBeFalsy();
    expect(await revisionOffsets("o1")).toEqual([1234]);
  });

  it("absent kafka_offset stores null — 024 behavior unchanged", async () => {
    await call("create_block", {
      container_id: "o2",
      text: "plain",
      authored_by: PRINCIPAL,
    });
    expect(await revisionOffsets("o2")).toEqual([null]);
  });

  it("an offset without a session author rejects naming the rule; nothing lands", async () => {
    const res = await call("create_block", {
      container_id: "o3",
      text: "should not land",
      kafka_offset: 42,
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.raw)).toMatch(/session-principal/);
    expect(await revisionOffsets("o3")).toEqual([]);

    const legacy = await call("create_block", {
      container_id: "o3",
      text: "still no",
      authored_by: "human",
      kafka_offset: 42,
    });
    expect(legacy.isError).toBe(true);
    expect(await revisionOffsets("o3")).toEqual([]);
  });

  it("a negative or fractional offset rejects via schema", async () => {
    const negative = await call("create_block", {
      container_id: "o4",
      text: "no",
      authored_by: PRINCIPAL,
      kafka_offset: -1,
    });
    expect(negative.isError).toBe(true);
    const fractional = await call("create_block", {
      container_id: "o4",
      text: "no",
      authored_by: PRINCIPAL,
      kafka_offset: 1.5,
    });
    expect(fractional.isError).toBe(true);
    expect(await revisionOffsets("o4")).toEqual([]);
  });

  it("the remaining write verbs thread the offset", async () => {
    const seeded = await call("apply_section_ops", {
      node_id: "o5",
      ops: [{ op: "add", text: "alpha", order_key: "a0" }],
      authored_by: PRINCIPAL,
      kafka_offset: 100,
    });
    expect(seeded.isError).toBeFalsy();

    const body = (
      (await call("read_body", { node_id: "o5" })).structured as {
        sections: { id: string }[];
      }
    ).sections;
    const alpha = body[0];
    if (!alpha) throw new Error("seed failed");

    const updated = await call("update_block", {
      container_id: "o5",
      block_id: alpha.id,
      text: "alpha edited",
      authored_by: PRINCIPAL,
      kafka_offset: 101,
    });
    expect(updated.isError).toBeFalsy();

    const appended = await call("append_section", {
      node_id: "o5",
      text: "beta",
      authored_by: PRINCIPAL,
      kafka_offset: 102,
    });
    expect(appended.isError).toBeFalsy();

    const written = await call("write_body", {
      node_id: "o5",
      sections: [{ text: "fresh" }],
      authored_by: PRINCIPAL,
      kafka_offset: 103,
    });
    expect(written.isError).toBeFalsy();

    // Newest first: write_body, append_section, update_block, seed.
    expect(await revisionOffsets("o5")).toEqual([103, 102, 101, 100]);
  });
});
