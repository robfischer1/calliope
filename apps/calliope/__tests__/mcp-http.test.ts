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
  it("serves the full verb surface via tools/list — the F3 fence", async () => {
    // This list IS the caller-facing surface contract: every shipped verb
    // traces to a decided master-plan Exposes row, and nothing ships that
    // traces to none. Change it only alongside the plan that licenses it.
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
      "apply_section_ops",
      "coalesce_block_writes",
      "copy_reference",
      "create_block",
      "create_comment",
      "create_note",
      "delete_block",
      "dissolve_note",
      "edit_section",
      "export_note",
      "file_revisions",
      "list_blocks",
      "list_by_tag",
      "list_comments",
      "list_tags",
      "look",
      "materialize_note",
      "merge_block",
      "read_block",
      "read_body",
      "read_body_at",
      "read_body_revisions",
      "read_documents",
      "read_plan",
      "revision_deltas",
      "split_block",
      "unpin",
      "update_block",
      "write_body",
      "write_document",
    ]);
  });

  it("every verb carries honest ToolAnnotations — the F10 map (B7's fence)", async () => {
    // The pinned map: readOnlyHint / destructiveHint / idempotentHint per
    // verb. A new verb without annotations fails here by construction.
    const MAP: Record<string, [boolean, boolean, boolean]> = {
      // reads
      read_body: [true, false, true],
      read_block: [true, false, true],
      list_blocks: [true, false, true],
      read_body_revisions: [true, false, true],
      read_body_at: [true, false, true],
      read_documents: [true, false, true],
      read_plan: [true, false, true],
      file_revisions: [true, false, true],
      revision_deltas: [true, false, true],
      list_by_tag: [true, false, true],
      list_tags: [true, false, true],
      export_note: [true, false, true],
      materialize_note: [true, false, true],
      copy_reference: [true, false, true],
      look: [true, false, true],
      list_comments: [true, false, true],
      unpin: [false, true, true],
      // additive writes (each call mints new ids)
      create_block: [false, false, false],
      create_comment: [false, false, false],
      append_section: [false, false, false],
      split_block: [false, false, false],
      merge_block: [false, false, false],
      // idempotent writes (no-op convergence tested in their own suites)
      update_block: [false, false, true],
      edit_section: [false, false, true],
      create_note: [false, false, true],
      write_document: [false, false, true],
      dissolve_note: [false, false, true],
      // destructive
      apply_section_ops: [false, true, false],
      delete_block: [false, true, false],
      write_body: [false, true, false],
      coalesce_block_writes: [false, true, true],
    };
    await rpc(initEnvelope(1));
    const listed = (await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })) as {
      result?: {
        tools?: {
          name: string;
          title?: string;
          annotations?: {
            readOnlyHint?: boolean;
            destructiveHint?: boolean;
            idempotentHint?: boolean;
          };
        }[];
      };
    };
    const tools = listed.result?.tools ?? [];
    expect(tools.length).toBe(Object.keys(MAP).length);
    for (const tool of tools) {
      const expected = MAP[tool.name];
      expect(expected, `unmapped verb ${tool.name}`).toBeDefined();
      if (!expected) continue;
      const a = tool.annotations;
      expect(a, `${tool.name} carries no annotations`).toBeDefined();
      expect(
        [
          a?.readOnlyHint ?? false,
          a?.destructiveHint ?? false,
          a?.idempotentHint ?? false,
        ],
        `${tool.name} hints`,
      ).toEqual(expected);
    }
  });

  it("coalesce_block_writes refuses while the F8 flag is off (default)", async () => {
    await rpc(initEnvelope(1));
    const res = (await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "coalesce_block_writes",
        arguments: {
          container_id: "n-x",
          block_id: "b-x",
          since_revision: "2026-01-01T00:00:00.000000Z",
        },
      },
    })) as {
      result?: {
        isError?: boolean;
        structuredContent?: { error?: string };
      };
    };
    expect(res.result?.isError).toBe(true);
    expect(res.result?.structuredContent?.error).toBe("coalesce_disabled");
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
