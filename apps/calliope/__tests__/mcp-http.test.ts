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
      "blob_census", // F7 — the inverted-census GC (mark-and-sweep)
      "container_history", // F5 — history IS the graph (as-of reads)
      "copy_reference",
      "create_note",
      "dissolve_note",
      "export_note",
      "file_revisions", // stays [Rob, F12] — frozen archive, read-only
      "list_by_tag",
      "list_tags",
      "look",
      "materialize_note",
      "read_container", // F5 — the ordered tree read
      "revision_deltas", // stays [Rob, F12] — frozen archive, read-only
      "search", // Findability F2 — licensed by its Exposes row `search(query, scope)`
      "unpin",
      "write_container", // F4 — the ONE write path since the F12 cut
    ]);
  });

  it("every verb carries honest ToolAnnotations — the F10 map (B7's fence)", async () => {
    // The pinned map: readOnlyHint / destructiveHint / idempotentHint per
    // verb. A new verb without annotations fails here by construction.
    const MAP: Record<string, [boolean, boolean, boolean]> = {
      // reads
      read_container: [true, false, true],
      blob_census: [false, true, false], // F7 — the sweep reaps marked blobs

      container_history: [true, false, true],
      file_revisions: [true, false, true],
      revision_deltas: [true, false, true],
      list_by_tag: [true, false, true],
      list_tags: [true, false, true],
      export_note: [true, false, true],
      materialize_note: [true, false, true],
      copy_reference: [true, false, true],
      look: [true, false, true],
      search: [true, false, true], // Findability F2 — read-only, idempotent

      unpin: [false, true, true],
      // idempotent writes (no-op convergence tested in their own suites)
      create_note: [false, false, true],
      dissolve_note: [false, false, true],
      // the ONE write path (F4/F12): a save whose ops all net out writes
      // nothing, but the verb itself is not idempotent (adds mint slots)
      write_container: [false, false, false],
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

describe("the PRODUCTION boot shape (prebuilt client, F12 regression pin)", () => {
  it("serves the container surface when booted exactly as main() boots", async () => {
    // The live outage this pins (found on the deployed star, 2026-08-16):
    // main() passes a PREBUILT client with each facet as a positional arg,
    // which SKIPS the make-the-backend-internally branch — so a facet
    // main() forgets to pass silently vanishes from the served surface
    // while the fixture-path test above stays green. Boot the server the
    // way main() does and pin the write path's presence.
    const { makeBackend } = await import("../src/mcp/backend.js");
    const { FocusRegister } = await import("../src/focus-register.js");
    const backend = makeBackend("fixture");
    const server = createCalliopeHttpServer(
      "fixture",
      backend.client,
      backend.documents,
      backend.revisions,
      backend.chaos,
      backend.tags,
      new FocusRegister(),
      backend.containers,
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      const text = await res.text();
      const line = text.split("\n").find((l) => l.startsWith("data:"));
      const listed = JSON.parse(line !== undefined ? line.slice(5) : text) as {
        result?: { tools?: { name: string }[] };
      };
      const names = (listed.result?.tools ?? []).map((t) => t.name);
      expect(names).toContain("write_container");
      expect(names).toContain("read_container");
      expect(names).toContain("container_history");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
