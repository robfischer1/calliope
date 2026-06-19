import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCalliopeHttpServer, resolvePort } from "../src/mcp/http.js";

/**
 * Drive the calliope-mcp HTTP star over a real socket, fixture-backed — the
 * same four-tool server the stdio bin exposes, reached the way Hades reaches a
 * star: an `initialize` handshake then stateless `tools/list` / `tools/call`
 * JSON-RPC POSTs to `/mcp`.
 */

let server: Server;
let base: string;

/** Streamable-HTTP requires both content types in Accept. */
const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

/** POST one JSON-RPC envelope and parse the body (JSON or an SSE data frame). */
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
    // Pull the JSON payload out of the last `data:` line of the SSE frame.
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

beforeEach(async () => {
  // Fixture backend: no urania connection, deterministic in-memory body model.
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

describe("calliope-mcp HTTP star — fixture-backed over a real socket", () => {
  it("serves the same four tools as the stdio server via tools/list", async () => {
    await rpc(initEnvelope(1));
    const listed = (await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })) as { result?: { tools?: { name: string }[] } };
    const names = (listed.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      "append_section",
      "edit_section",
      "read_body",
      "write_body",
    ]);
  });

  it("round-trips write_body then read_body over HTTP", async () => {
    await rpc(initEnvelope(1));
    const wrote = (await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "write_body",
        arguments: {
          node_id: "n-http",
          sections: [{ text: "intro" }, { text: "body" }],
        },
      },
    })) as {
      result?: { structuredContent?: { count?: number; ok?: boolean } };
    };
    expect(wrote.result?.structuredContent).toMatchObject({
      ok: true,
      count: 2,
    });

    const read = (await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "read_body", arguments: { node_id: "n-http" } },
    })) as {
      result?: { structuredContent?: { sections?: { text: string }[] } };
    };
    expect(
      (read.result?.structuredContent?.sections ?? []).map((s) => s.text),
    ).toEqual(["intro", "body"]);
  });

  it("404s a non-/mcp path and 405s a GET on /mcp", async () => {
    const notFound = await fetch(`${base}/healthz`, { method: "GET" });
    expect(notFound.status).toBe(404);
    const wrongMethod = await fetch(`${base}/mcp`, { method: "GET" });
    expect(wrongMethod.status).toBe(405);
  });
});

describe("resolvePort", () => {
  it("prefers PORT, then CALLIOPE_MCP_PORT, then 8204", () => {
    expect(resolvePort({ PORT: "9000" })).toBe(9000);
    expect(resolvePort({ CALLIOPE_MCP_PORT: "9100" })).toBe(9100);
    expect(resolvePort({ PORT: "9000", CALLIOPE_MCP_PORT: "9100" })).toBe(9000);
    expect(resolvePort({})).toBe(8204);
    expect(resolvePort({ PORT: "not-a-port" })).toBe(8204);
  });
});
