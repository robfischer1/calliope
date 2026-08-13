/**
 * Findability F4 (spec 034) — the eros-routed pg arm: envelope mapping,
 * source filter on the wire, k pass-through, dark on unreachable/timeout.
 * The provider speaks real streamable-HTTP MCP against a stub eros server.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  ErosSearchProvider,
  erosUrl,
  makeErosProvider,
} from "../src/fs-search/eros-provider.js";

let stub: Server | null = null;

afterEach(async () => {
  if (stub !== null) {
    await new Promise((resolve) => stub?.close(resolve));
    stub = null;
  }
});

/** A minimal eros: one `search` tool answering `results`, args recorded. */
async function startStubEros(
  results: Record<string, unknown>[],
): Promise<{ base: string; calls: Record<string, unknown>[] }> {
  const calls: Record<string, unknown>[] = [];
  stub = createServer((req, res) => {
    void (async (): Promise<void> => {
      const mcp = new McpServer({ name: "eros-stub", version: "0" });
      mcp.registerTool(
        "search",
        {
          inputSchema: {
            query: z.string(),
            k: z.number().optional(),
            source: z.string().optional(),
            since: z.string().optional(),
          },
        },
        (args) => {
          calls.push(args);
          return Promise.resolve({
            content: [{ type: "text", text: "ok" }],
            structuredContent: { results },
          });
        },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body =
        chunks.length === 0
          ? undefined
          : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => {
    stub?.listen(0, "127.0.0.1", resolve);
  });
  const address = stub.address() as AddressInfo;
  return { base: `http://127.0.0.1:${String(address.port)}`, calls };
}

describe("ErosSearchProvider", () => {
  it("maps eros hits to the ruled envelope with the source filter on the wire", async () => {
    const { base, calls } = await startStubEros([
      {
        doc_id: 1,
        source_id: 42,
        title: "The Note",
        snippet: "matched text",
        score: 0.031,
        source_table: "calliope_documents",
      },
      { doc_id: 2, source_id: 43, title: null, snippet: "bare", score: 0.02 },
    ]);
    const provider = new ErosSearchProvider(base);
    const res = await provider.search("heron", undefined, 7);
    expect(res.armsQueried).toEqual(["eros"]);
    expect(res.armsDark).toEqual([]);
    expect(res.hits).toEqual([
      {
        id: "42",
        snippet: "The Note — matched text",
        score: 0.031,
        arms: ["eros"],
      },
      { id: "43", snippet: "bare", score: 0.02, arms: ["eros"] },
    ]);
    expect(calls[0]).toMatchObject({
      query: "heron",
      k: 7,
      source: "calliope_documents",
      since: "1900",
    });
  });

  it("degrades to a named dark arm when eros is unreachable", async () => {
    const provider = new ErosSearchProvider("http://127.0.0.1:1");
    const res = await provider.search("anything");
    expect(res.hits).toEqual([]);
    expect(res.armsQueried).toEqual([]);
    expect(res.armsDark).toEqual(["eros"]);
  });
});

describe("configuration", () => {
  it("erosUrl reads and normalizes the env; unset = no arm", () => {
    expect(erosUrl({})).toBeNull();
    expect(erosUrl({ CALLIOPE_EROS_URL: "" })).toBeNull();
    expect(erosUrl({ CALLIOPE_EROS_URL: "http://eros:8080/" })).toBe(
      "http://eros:8080",
    );
    expect(makeErosProvider({})).toBeUndefined();
    expect(
      makeErosProvider({ CALLIOPE_EROS_URL: "http://eros:8080" }),
    ).toBeInstanceOf(ErosSearchProvider);
  });
});
