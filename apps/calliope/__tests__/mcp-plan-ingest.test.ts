/**
 * C7 `read_plan` over the MCP HTTP star, fixture-backed — the exact surface
 * athena's `orchestrate_plan` dials over the Hades gateway. Proves the verb is
 * registered, that a plan written via `write_document` reads back BY REFERENCE
 * whole-doc (block index) and single-block (block-addressable) by handle.
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

function initEnvelope(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    },
  };
}

function callEnvelope(
  id: number,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

function resultOf(res: Record<string, unknown>): Record<string, unknown> {
  return res.result as Record<string, unknown>;
}

function structuredOf(res: Record<string, unknown>): Record<string, unknown> {
  return resultOf(res).structuredContent as Record<string, unknown>;
}

const PLAN_SOURCE = "System/Pantheon/WBS/Calliope — Master-plan.md";
const PLAN_BODY = `# Calliope — Master-plan

# Feature list — amend increment

### C6 — The vault carve: Calliope eats all the markdown  ·  L
- **Brief:** Finish the vault→Calliope dissolution.

### C7 — The plan-ingest surface (athena by-reference projection)  ·  M
- **Brief:** Give Calliope a projection-shaped ingest read.
`;

beforeEach(async () => {
  server = createCalliopeHttpServer("fixture");
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${String(addr.port)}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

async function seedPlan(): Promise<number> {
  await rpc(initEnvelope(1));
  const write = structuredOf(
    await rpc(
      callEnvelope(2, "write_document", {
        source_path: PLAN_SOURCE,
        body_text: PLAN_BODY,
        schema_type: "Plan",
        subject: "Calliope — Master-plan",
      }),
    ),
  );
  return write.id as number;
}

describe("read_plan (the C7 verb, wire-level)", () => {
  it("registers read_plan beside the document verbs", async () => {
    await rpc(initEnvelope(1));
    const res = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const tools = (res.result as { tools: { name: string }[] }).tools.map(
      (t) => t.name,
    );
    expect(tools).toContain("read_plan");
    expect(tools).toContain("read_documents"); // built on the C3 store
  });

  it("serves the WHOLE plan by reference (id handle → block index + body)", async () => {
    const id = await seedPlan();
    const whole = structuredOf(
      await rpc(callEnvelope(3, "read_plan", { document: id })),
    );
    expect(whole.block_count).toBe(2);
    const blocks = whole.blocks as { id: string; size: string }[];
    expect(blocks.map((b) => b.id)).toEqual(["C6", "C7"]);
    expect(blocks.map((b) => b.size)).toEqual(["L", "M"]);
    expect(whole.body_text).toBe(PLAN_BODY);
    const handle = whole.handle as { document: number; source_path: string };
    expect(handle.document).toBe(id);
    expect(handle.source_path).toBe(PLAN_SOURCE);
  });

  it("serves the whole plan by source_path handle", async () => {
    await seedPlan();
    const whole = structuredOf(
      await rpc(callEnvelope(3, "read_plan", { source_path: PLAN_SOURCE })),
    );
    expect(whole.block_count).toBe(2);
  });

  it("serves a SINGLE feature block by handle (block-addressable)", async () => {
    const id = await seedPlan();
    const one = structuredOf(
      await rpc(callEnvelope(3, "read_plan", { document: id, block: "C7" })),
    );
    const block = one.block as { id: string; size: string; text: string };
    expect(block.id).toBe("C7");
    expect(block.size).toBe("M");
    expect(block.text).toContain("projection-shaped ingest read");
    expect(block.text).not.toContain("The vault carve"); // not C6
    const handle = one.handle as { block: string };
    expect(handle.block).toBe("C7"); // the returnable block ref
  });

  it("returns a structured, isError miss for an unknown block", async () => {
    const id = await seedPlan();
    const res = await rpc(
      callEnvelope(3, "read_plan", { document: id, block: "Z9" }),
    );
    expect(resultOf(res).isError).toBe(true);
    expect(structuredOf(res).error).toBe("block_not_found");
  });
});

describe("list_blocks — the general container index (F5)", () => {
  it("serves a plan document's index with NO body text", async () => {
    const id = await seedPlan();
    const index = structuredOf(
      await rpc(callEnvelope(3, "list_blocks", { document: id })),
    );
    expect(index.kind).toBe("document");
    expect(index.block_count).toBe(2);
    const blocks = index.blocks as Record<string, unknown>[];
    expect(blocks.map((b) => b.id)).toEqual(["C6", "C7"]);
    expect(blocks.map((b) => b.size)).toEqual(["L", "M"]);
    expect(blocks.map((b) => b.order)).toEqual([0, 1]);
    // The index NEVER carries prose.
    expect(index.body_text).toBeUndefined();
    for (const b of blocks) expect(b.text).toBeUndefined();
  });

  it("serves a section container's index with NO prose", async () => {
    await rpc(initEnvelope(1));
    await rpc(
      callEnvelope(2, "write_body", {
        node_id: "n-idx",
        sections: [
          { text: "First paragraph line\nmore prose here" },
          { text: "Second block" },
        ],
      }),
    );
    const index = structuredOf(
      await rpc(callEnvelope(3, "list_blocks", { container_id: "n-idx" })),
    );
    expect(index.kind).toBe("node");
    expect(index.block_count).toBe(2);
    const blocks = index.blocks as {
      id: string;
      title: string;
      chars: number;
      order_key: string;
    }[];
    expect(blocks.map((b) => b.title)).toEqual([
      "First paragraph line",
      "Second block",
    ]);
    expect(blocks[0]?.chars).toBe(
      "First paragraph line\nmore prose here".length,
    );
    const keys = blocks.map((b) => b.order_key);
    expect([...keys].sort()).toEqual(keys);
    for (const b of blocks as Record<string, unknown>[]) {
      expect(b.text).toBeUndefined();
    }
  });

  it("misses are structured: bad_handle and document_not_found", async () => {
    await rpc(initEnvelope(1));
    const none = await rpc(callEnvelope(2, "list_blocks", {}));
    expect(resultOf(none).isError).toBe(true);
    expect(structuredOf(none).error).toBe("bad_handle");
    const gone = await rpc(callEnvelope(3, "list_blocks", { document: 9999 }));
    expect(resultOf(gone).isError).toBe(true);
    expect(structuredOf(gone).error).toBe("document_not_found");
  });
});

describe("read_block — the document-handle family (F5)", () => {
  it("serves exactly one feature block's markdown by document handle", async () => {
    const id = await seedPlan();
    const one = structuredOf(
      await rpc(
        callEnvelope(3, "read_block", { document: id, block_id: "c7" }),
      ),
    );
    const block = one.block as { id: string; text: string; size: string };
    expect(block.id).toBe("C7");
    expect(block.size).toBe("M");
    expect(block.text).toContain("projection-shaped ingest read");
    expect(block.text).not.toContain("The vault carve");
  });

  it("misses are structured on the document family", async () => {
    const id = await seedPlan();
    const badBlock = await rpc(
      callEnvelope(3, "read_block", { document: id, block_id: "Z9" }),
    );
    expect(resultOf(badBlock).isError).toBe(true);
    expect(structuredOf(badBlock).error).toBe("block_not_found");
    const badDoc = await rpc(
      callEnvelope(4, "read_block", { document: 9999, block_id: "C7" }),
    );
    expect(resultOf(badDoc).isError).toBe(true);
    expect(structuredOf(badDoc).error).toBe("document_not_found");
    const noHandle = await rpc(
      callEnvelope(5, "read_block", { block_id: "C7" }),
    );
    expect(resultOf(noHandle).isError).toBe(true);
    expect(structuredOf(noHandle).error).toBe("bad_handle");
  });

  it("the node family still works unchanged (F3 contract)", async () => {
    await rpc(initEnvelope(1));
    await rpc(
      callEnvelope(2, "write_body", {
        node_id: "n-rb",
        sections: [{ text: "only block" }],
      }),
    );
    const body = structuredOf(
      await rpc(callEnvelope(3, "read_body", { node_id: "n-rb" })),
    );
    const sections = body.sections as { id: string }[];
    const sid = sections[0]?.id ?? "";
    const one = structuredOf(
      await rpc(
        callEnvelope(4, "read_block", { container_id: "n-rb", block_id: sid }),
      ),
    );
    expect((one.block as { text: string }).text).toBe("only block");
  });
});
