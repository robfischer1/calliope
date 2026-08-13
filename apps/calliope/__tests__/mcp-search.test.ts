import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { createServer } from "../src/mcp/server.js";
import type { SearchProvider, SearchResponse } from "../src/fs-search/index.js";

async function connect(provider?: SearchProvider): Promise<Client> {
  const server = createServer(new FixtureBodyClient(), { search: provider });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("the search verb over MCP", () => {
  it("registers on every backend (present in tools/list)", async () => {
    const client = await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("search");
  });

  it("without a provider answers honest darkness — not an error, not hidden", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "search",
      arguments: { query: "anything" },
    });
    const body = res.structuredContent as SearchResponse;
    expect(body.hits).toEqual([]);
    expect(body.armsQueried).toEqual([]);
    expect(body.armsDark.sort()).toEqual(["fts", "semantic"]);
  });

  it("with a provider passes query/scope/k through and returns its envelope", async () => {
    const calls: unknown[] = [];
    const provider: SearchProvider = {
      search: (query, scope, k) => {
        calls.push([query, scope, k]);
        return Promise.resolve({
          hits: [{ id: "x.md", snippet: "snip", score: 1, arms: ["fts"] }],
          armsQueried: ["fts"],
          armsDark: ["semantic"],
        } satisfies SearchResponse);
      },
    };
    const client = await connect(provider);
    const res = await client.callTool({
      name: "search",
      arguments: { query: "heron", scope: "notes", k: 5 },
    });
    expect(calls).toEqual([["heron", "notes", 5]]);
    const body = res.structuredContent as SearchResponse;
    expect(body.hits[0]?.id).toBe("x.md");
    expect(body.armsDark).toEqual(["semantic"]);
    // The text summary names the dark arm — the UI's honesty hook.
    const text =
      (res.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(text).toContain("dark: semantic");
  });
});
