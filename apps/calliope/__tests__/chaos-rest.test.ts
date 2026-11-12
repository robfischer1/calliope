/**
 * LiveChaosDial over chaos's openapi-http face (chaos-rest.ts): the REST
 * routes every read to /v1/<verb> on the plaintext door and shapes the
 * answer. The document is a slice of chaos's
 * live /openapi.json (2026-10-29); fetch is stubbed, nothing leaves the
 * process.
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { LiveChaosDial } from "../src/chaos-client.js";
import { ChaosRest } from "../src/chaos-rest.js";

const DOC = readFileSync(
  new URL("./fixtures/chaos-openapi-subset.json", import.meta.url),
  "utf8",
);
const ENVELOPE = "application/vnd.stellar.result+json";

interface Seen {
  method: string;
  url: string;
  body: string | null;
}

/** A chaos door: the document, then each call answered by answer(path). */
function door(answer: (path: string) => Response): {
  fetch: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const fake = (input: string, init?: RequestInit) => {
    const url = input;
    const path = new URL(url).pathname;
    if (path === "/openapi.json") {
      return Promise.resolve(
        new Response(DOC, {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Star": "chaos" },
        }),
      );
    }
    const body = typeof init?.body === "string" ? init.body : null;
    seen.push({ method: init?.method ?? "GET", url, body });
    return Promise.resolve(answer(path));
  };
  return { fetch: fake as unknown as typeof fetch, seen };
}

function structured(value: unknown): Response {
  return new Response(JSON.stringify({ text: "", structuredContent: value }), {
    status: 200,
    headers: { "Content-Type": ENVELOPE, "X-Star": "chaos" },
  });
}

const TOKEN = "a".repeat(64);
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("LiveChaosDial with the chaos REST flip", () => {
  it("dials a GET read on /v1/<verb> and unwraps its {result}", async () => {
    const d = door(() => structured({ result: [TOKEN, "not-a-token"] }));
    const dial = new LiveChaosDial({
      chaosRest: new ChaosRest("http://chaos:8209", 5_000, d.fetch),
    });
    expect(await dial.findByName("Note", "x")).toEqual([TOKEN]);
    expect(d.seen).toHaveLength(1);
    expect(d.seen[0]?.method).toBe("GET");
    expect(d.seen[0]?.url).toMatch(/^http:\/\/chaos:8209\/v1\/find_by_name\?/);
  });

  it("sends a POST read's arguments as the body, nulls kept", async () => {
    const d = door(() => structured({ result: [] }));
    const dial = new LiveChaosDial({
      chaosRest: new ChaosRest("http://chaos:8209", 5_000, d.fetch),
    });
    await dial.quadsFrom([TOKEN], null, null);
    expect(d.seen[0]?.method).toBe("POST");
    expect(d.seen[0]?.url).toBe("http://chaos:8209/v1/quads_from");
    const body = JSON.parse(d.seen[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.subjects).toEqual([TOKEN]);
    expect(body).toHaveProperty("as_of_tx", null);
  });

  it("parses text when no structuredContent rode", async () => {
    const d = door(
      () =>
        new Response(JSON.stringify([TOKEN]), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Star": "chaos" },
        }),
    );
    const dial = new LiveChaosDial({
      chaosRest: new ChaosRest("http://chaos:8209", 5_000, d.fetch),
    });
    expect(await dial.findByName("Note", "x")).toEqual([TOKEN]);
  });

  it("types chaos's conflict refusal", async () => {
    const d = door(
      () =>
        new Response(JSON.stringify({ code: "conflict", detail: "held" }), {
          status: 409,
          headers: { "Content-Type": "application/json", "X-Star": "chaos" },
        }),
    );
    const dial = new LiveChaosDial({
      chaosRest: new ChaosRest("http://chaos:8209", 5_000, d.fetch),
    });
    await expect(dial.findByName("Note", "x")).rejects.toMatchObject({
      name: "ChaosClientError",
      code: "conflict",
    });
  });

  it("sends register_graph as POST /v1/register_graph", async () => {
    const rest = door(() => structured({}));
    const dial = new LiveChaosDial({
      chaosRest: new ChaosRest("http://chaos:8209", 5_000, rest.fetch),
    });
    await dial.registerGraph("notes");
    expect(rest.seen).toHaveLength(1);
    expect(rest.seen[0]?.method).toBe("POST");
    expect(rest.seen[0]?.url).toBe("http://chaos:8209/v1/register_graph");
    expect(JSON.parse(rest.seen[0]?.body ?? "{}")).toEqual({
      graph: "notes",
      name: "notes",
      author: "calliope",
    });
  });
});

describe("ChaosRest", () => {
  it("refuses a base that is not plaintext http://host[:port]", () => {
    expect(() => new ChaosRest("https://chaos:8207", 1_000)).toThrow(TypeError);
  });
});
