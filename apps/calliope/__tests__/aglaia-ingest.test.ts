/**
 * Charon parity rows 19 and 20: the tag seed and the writing-telemetry
 * ingest, ported from charon. No broker is dialled: every producer here is a
 * double, so the refusal split (drop vs replay), the one-send-per-batch rule
 * and the key rule are measured rather than inferred.
 */
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  MAX_BATCH,
  TAG_SEED_ENV,
  TELEMETRY_TOPIC,
  ingestBatch,
  readTagSeed,
  telemetryProducerOptions,
  telemetryRecords,
} from "../src/aglaia-ingest.js";
import type {
  TelemetryMessage,
  TelemetryProducerLike,
} from "../src/aglaia-ingest.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { createServer } from "../src/mcp/server.js";

const event = (over?: Record<string, unknown>): Record<string, unknown> => ({
  v: 1,
  type: "doc-change",
  ts: "2026-09-16T00:00:00.000Z",
  nodeId: "n1",
  eventId: "e1",
  ...over,
});

function double(fail?: Error): {
  producer: TelemetryProducerLike;
  sent: TelemetryMessage[][];
} {
  const sent: TelemetryMessage[][] = [];
  return {
    sent,
    producer: {
      send: ({ messages }) => {
        sent.push(messages);
        return fail === undefined ? Promise.resolve() : Promise.reject(fail);
      },
    },
  };
}

describe("tag seed (row 20)", () => {
  it("answers the seed, trimmed, read per call", () => {
    expect(readTagSeed({ [TAG_SEED_ENV]: " a=red:star \n" })).toEqual({
      tag_styles: "a=red:star",
    });
  });

  it("refuses not_found when unset or blank", () => {
    expect(readTagSeed({})).toMatchObject({ code: "not_found" });
    expect(readTagSeed({ [TAG_SEED_ENV]: "  " })).toMatchObject({
      code: "not_found",
    });
  });
});

describe("telemetry records (row 19)", () => {
  it("keys on nodeId, falls back to eventId, never the empty key", () => {
    const [a, b] = telemetryRecords([event(), event({ nodeId: "" })]);
    expect(a?.topic).toBe(TELEMETRY_TOPIC);
    expect(a?.key).toBe("n1");
    expect(b?.key).toBe("e1");
    expect(JSON.parse(a?.value ?? "{}")).toMatchObject({ nodeId: "n1" });
  });

  it("relays a type this fleet has not shipped", () => {
    expect(telemetryRecords([event({ type: "future-kind" })])).toHaveLength(1);
  });

  it("declares its producer options; never creates topics", () => {
    expect(telemetryProducerOptions("b:1")).toMatchObject({
      clientId: "calliope-telemetry",
      bootstrapBrokers: ["b:1"],
      autocreateTopics: false,
    });
  });
});

describe("ingestBatch: drop vs replay", () => {
  it("sends the whole batch in one call", async () => {
    const d = double();
    const answer = await ingestBatch(d.producer, [
      event(),
      event({ eventId: "e2" }),
    ]);
    expect(answer).toEqual({ accepted: 2, topic: TELEMETRY_TOPIC });
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]).toHaveLength(2);
  });

  it("refuses a contract-breaking event as bad_args and sends nothing", async () => {
    const d = double();
    const answer = await ingestBatch(d.producer, [
      event(),
      { v: 1, type: "doc-change" },
    ]);
    expect(answer).toMatchObject({ code: "bad_args" });
    expect(d.sent).toHaveLength(0);
  });

  it("refuses bad_args BEFORE the broker is asked, even when it is down", async () => {
    const d = double(new Error("down"));
    const answer = await ingestBatch(d.producer, [{ nodeId: "n1" }]);
    expect(answer).toMatchObject({ code: "bad_args" });
    expect(d.sent).toHaveLength(0);
  });

  it("refuses an empty, a non-array and an oversize batch as bad_args", async () => {
    const d = double();
    for (const bad of [[], "x", Array.from({ length: MAX_BATCH + 1 }, event)]) {
      expect(await ingestBatch(d.producer, bad)).toMatchObject({
        code: "bad_args",
      });
    }
    expect(d.sent).toHaveLength(0);
  });

  it("answers a broker fault as backend_unavailable (replay)", async () => {
    const d = double(new Error("connection refused"));
    const answer = await ingestBatch(d.producer, [event()]);
    expect(answer).toMatchObject({ code: "backend_unavailable" });
    expect(d.sent).toHaveLength(1);
  });
});

describe("the verbs on the wire", () => {
  async function client(producer?: TelemetryProducerLike): Promise<Client> {
    const server = createServer(new FixtureBodyClient(), {
      ...(producer !== undefined ? { telemetry: producer } : {}),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), mcp.connect(ct)]);
    return mcp;
  }

  it("registers the ingest only with a producer", async () => {
    const bare = (await (await client()).listTools()).tools.map((t) => t.name);
    expect(bare).toContain("tag_seed_read");
    expect(bare).not.toContain("writing_deltas_ingest");
  });

  it("answers each refusal as {code, detail}", async () => {
    vi.stubEnv(TAG_SEED_ENV, "");
    const mcp = await client(double(new Error("down")).producer);
    const seed = await mcp.callTool({ name: "tag_seed_read", arguments: {} });
    expect(seed.isError).toBe(true);
    expect(seed.structuredContent).toMatchObject({ code: "not_found" });
    const replay = await mcp.callTool({
      name: "writing_deltas_ingest",
      arguments: { events: [event()] },
    });
    expect(replay.structuredContent).toMatchObject({
      code: "backend_unavailable",
    });
    const drop = await mcp.callTool({
      name: "writing_deltas_ingest",
      arguments: { events: [{ nodeId: "n1" }] },
    });
    expect(drop.structuredContent).toMatchObject({ code: "bad_args" });
    vi.unstubAllEnvs();
  });
});
