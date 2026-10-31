import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/mcp/server.js";
import { makeWitness } from "../src/mcp/witness.js";
import { bareClient } from "./helpers/bare-client.js";
import { recordingWitness, serveDoor, toolRecords } from "./rest-door.js";

/**
 * The witness, end to end: a verb called on the SERVED door (the REST door,
 * calliope's only listener since REST mesh P7 rm39) leaves exactly one tool
 * record beside the HTTP door's `rest.<verb>` record, and the spec leaves none.
 * Peer attribution on the REST door is the SDK's (stellar-core-ts
 * rest.attributed / rest.soleequivalence tests).
 */

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function served(): Promise<{
  base: string;
  got: ReturnType<typeof recordingWitness>["got"];
}> {
  const { witness, got } = recordingWitness();
  const { rest, base } = await serveDoor({ witness });
  closers.push(() => rest.close());
  return { base, got };
}

describe("the served door leaves one tool record per call", () => {
  it("a read-only call leaves exactly one tool record: unidentified, path unknown", async () => {
    const { base, got } = await served();
    expect((await fetch(`${base}/v1/list_tags`)).status).toBe(200);
    const recs = toolRecords(got);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      star: "calliope",
      verb: "list_tags",
      caller_class: "unidentified",
      path: "unknown",
      outcome: "ok",
      transport: "rest",
    });
    expect(Object.keys(recs[0] ?? {})).not.toContain("caller_identity");
    expect(got.map((r) => r.verb)).toContain("rest.list_tags");
  });

  it("the spec leaves none; two calls leave two", async () => {
    const { base, got } = await served();
    expect((await fetch(`${base}/openapi.json`)).status).toBe(200);
    expect(got).toHaveLength(0);
    await fetch(`${base}/v1/list_tags`);
    await fetch(`${base}/v1/look`);
    expect(toolRecords(got).map((r) => r.verb)).toEqual(["list_tags", "look"]);
  });

  it("an unknown verb is never dispatched: one HTTP record, unknown_verb", async () => {
    const { base, got } = await served();
    const res = await fetch(`${base}/v1/no_such_verb`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(toolRecords(got)).toHaveLength(0);
    expect(got).toMatchObject([
      { verb: "rest.unknown", outcome: "unknown_verb" },
    ]);
  });

  it("the door is the only listener: no /mcp, and the probes answer", async () => {
    const { base } = await served();
    expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(404);
    for (const path of ["/live", "/ready", "/metrics"]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(200);
    }
  });

  it("closing the door closes the witness's sink", async () => {
    const { witness, closed } = recordingWitness();
    const { rest } = await serveDoor({ witness });
    expect(closed()).toBe(0);
    await rest.close();
    expect(closed()).toBe(1);
  });

  it("a refused mount (no REST port) closes the sink and serves nothing", async () => {
    const { witness, closed } = recordingWitness();
    await expect(
      serveDoor({ witness }, { STELLAR_REST_PLAINTEXT_PORT: "" }),
    ).rejects.toThrow(/STELLAR_REST_PLAINTEXT_PORT/);
    expect(closed()).toBe(1);
  });
});

describe("createServer", () => {
  it("builds with no options at all — the witness is optional and absence is not a fault", () => {
    expect(() => createServer(bareClient({}))).not.toThrow();
  });
});

describe("makeWitness", () => {
  it("close delegates to the sink it built, and the star's name and broker reach it", async () => {
    let closed = 0;
    const seen: unknown[] = [];
    const w = makeWitness({ KAFKA_BOOTSTRAP: "broker:9092" }, (opts) => {
      seen.push(opts);
      return {
        sink: () => undefined,
        reach: "topic",
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      };
    });
    expect(seen).toEqual([{ star: "calliope", bootstrap: "broker:9092" }]);
    expect(w.log.enabled).toBe(true);
    await w.close();
    expect(closed).toBe(1);
  });

  it("with no broker, records to the log stream and says so once", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const w = makeWitness({});
      w.log.record("calliope_x", {
        callerClass: "star",
        callerIdentity: "spiffe://notusmi.com/star/hades",
        path: "gateway",
      });
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(
        lines.filter((l) => l.includes("no broker configured")),
      ).toHaveLength(1);
      const recordLine = lines.find((l) => l.includes("msg=request_log"));
      expect(recordLine).toContain('\\"verb\\":\\"calliope_x\\"');
      await w.close();
    } finally {
      spy.mockRestore();
    }
  });

  it("with a broker named, builds the topic sink without dialling it", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const w = makeWitness({ KAFKA_BOOTSTRAP: "127.0.0.1:1" });
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(
        lines.some((l) =>
          l.includes(
            "witnessing inbound calls star=calliope topic=calliope._ops.calls",
          ),
        ),
      ).toBe(true);
      expect(w.log.enabled).toBe(true);
      await w.close();
    } finally {
      spy.mockRestore();
    }
  });
});
