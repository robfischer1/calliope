/**
 * C3 verb tests — `write_document` / `read_documents` over the MCP HTTP star,
 * fixture-backed: the wire surface vault-mcp's repointed dissolve will call
 * (via hades `tools/call`), driven exactly the way the gateway drives it.
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

function structuredOf(res: Record<string, unknown>): Record<string, unknown> {
  const result = res.result as Record<string, unknown>;
  return result.structuredContent as Record<string, unknown>;
}

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

describe("write_document / read_documents (the C3 verbs, wire-level)", () => {
  it("registers the document verbs beside the body verbs", async () => {
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
    expect(tools).toContain("write_document");
    expect(tools).toContain("read_documents");
    expect(tools).toContain("write_body"); // the body facet is untouched
  });

  it("writes the translator's payload shape verbatim and dedups the retry", async () => {
    await rpc(initEnvelope(1));
    // The exact doc_payload shape vault-mcp's translator emits.
    const payload = {
      source_path: "Brain Soup/Dissolved.md",
      body_text: "the dissolved body — verbatim",
      schema_type: "DigitalDocument",
      subject: "Dissolved",
      file_path: "/vault/Brain Soup/Dissolved.md",
      mtime: "2026-07-01",
      ctime: "2026-06-01",
    };
    const first = structuredOf(
      await rpc(callEnvelope(2, "write_document", payload)),
    );
    expect(first.ok).toBe(true);
    expect(first.table).toBe("documents");
    expect(first.deduped).toBe(false);

    const retry = structuredOf(
      await rpc(callEnvelope(3, "write_document", payload)),
    );
    expect(retry.deduped).toBe(true);

    const read = structuredOf(
      await rpc(
        callEnvelope(4, "read_documents", {
          source_path: "Brain Soup/Dissolved.md",
        }),
      ),
    );
    const docs = read.documents as { body_text: string; title: string }[];
    expect(docs).toHaveLength(1);
    expect(docs[0]?.body_text).toBe("the dissolved body — verbatim");
    expect(docs[0]?.title).toBe("Dissolved");
  });
});
