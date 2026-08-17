/**
 * Findability F10 (spec 036) — bulk prose-presence: one call for a whole
 * extent, absent ids omitted, the unsupported-backend guard honest.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { createServer } from "../src/mcp/server.js";
import type { BodyClient } from "../src/types.js";

async function connect(client: BodyClient): Promise<Client> {
  const server = createServer(client, { pathBodies: true });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return mcp;
}

describe("has_body", () => {
  it("answers block counts for the extent in one call; absent ids omitted", async () => {
    const fixture = new FixtureBodyClient();
    await fixture.saveBody("n1", [{ text: "one" }, { text: "two" }]);
    await fixture.saveBody("n2", [{ text: "only" }]);
    const mcp = await connect(fixture);
    const res = await mcp.callTool({
      name: "has_body",
      arguments: { node_ids: ["n1", "n2", "n3-empty"] },
    });
    const body = res.structuredContent as {
      present: { node_id: string; blocks: number }[];
    };
    const sorted = [...body.present].sort((a, b) =>
      a.node_id.localeCompare(b.node_id),
    );
    expect(sorted).toEqual([
      { node_id: "n1", blocks: 2 },
      { node_id: "n2", blocks: 1 },
    ]);
  });
});
