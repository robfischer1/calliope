/**
 * LiveChaosDial.admit over themis's plaintext REST door (rest-mesh P4):
 * with a REST base the admit is POST /v1/admit and never an MCP call; a
 * themis refusal keeps the MCP path's error shape; with none, admit stays
 * MCP. fetch is stubbed; nothing leaves the process. The document is
 * themis's own GET /openapi.json, trimmed to admit (2026-10-29).
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChaosClientError, LiveChaosDial } from "../src/chaos-client.js";

const DOC = readFileSync(
  new URL("./fixtures-themis-admit-openapi.json", import.meta.url),
  "utf8",
);

interface Seen {
  url: string;
  method: string;
  body: string;
}

let seen: Seen[] = [];
let answer: { status: number; body: string } = { status: 200, body: "" };
const realFetch = globalThis.fetch;

beforeEach(() => {
  seen = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = init?.method ?? "GET";
    seen.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : "",
    });
    const json = { "content-type": "application/json", "X-Star": "themis" };
    if (url.endsWith("/openapi.json")) {
      return Promise.resolve(new Response(DOC, { status: 200, headers: json }));
    }
    if (url.endsWith("/mcp")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              structuredContent: { admitted: true, minted: [], tx: 1 },
            },
          }),
          { status: 200, headers: json },
        ),
      );
    }
    return Promise.resolve(
      new Response(answer.body, { status: answer.status, headers: json }),
    );
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const OPS = [{ op: "create", kind: "Note", label: "n" }];

describe("LiveChaosDial.admit over REST", () => {
  it("posts /v1/admit on the REST door and never dials MCP", async () => {
    answer = {
      status: 200,
      body: JSON.stringify({ admitted: true, minted: ["42"], tx: 7 }),
    };
    const dial = new LiveChaosDial({
      themisUrl: "http://themis:8200",
      themisRestUrl: "http://themis:8203/",
    });
    const out = await dial.admit(OPS, "notes");
    expect(out).toEqual({
      admitted: true,
      minted: ["42"],
      violations: [],
      tx: 7,
    });
    const post = seen.filter((s) => s.method === "POST");
    expect(post).toHaveLength(1);
    expect(post[0]?.url).toBe("http://themis:8203/v1/admit");
    expect(JSON.parse(post[0]?.body ?? "{}")).toEqual({
      ops: OPS,
      scope: "notes",
    });
    expect(seen.some((s) => s.url.endsWith("/mcp"))).toBe(false);
  });

  it("a themis conflict is the registered conflict, and is not re-sent", async () => {
    answer = {
      status: 409,
      body: JSON.stringify({ code: "conflict", detail: "slot held" }),
    };
    const dial = new LiveChaosDial({
      themisUrl: "http://themis:8200",
      themisRestUrl: "http://themis:8203",
    });
    const err = await dial.admit(OPS, "notes").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChaosClientError);
    expect((err as ChaosClientError).code).toBe("conflict");
    expect(seen.some((s) => s.url.endsWith("/mcp"))).toBe(false);
  });

  it("any other refusal is a wire error, not a fall back to MCP", async () => {
    answer = {
      status: 403,
      body: JSON.stringify({ code: "denied", detail: "no grant" }),
    };
    const dial = new LiveChaosDial({
      themisUrl: "http://themis:8200",
      themisRestUrl: "http://themis:8203",
    });
    const err = await dial.admit(OPS, "notes").catch((e: unknown) => e);
    expect((err as ChaosClientError).code).toBe("wire_error");
    expect(seen.some((s) => s.url.endsWith("/mcp"))).toBe(false);
  });

  it("without a REST base, admit stays MCP", async () => {
    const prev = process.env.CALLIOPE_THEMIS_REST_URL;
    delete process.env.CALLIOPE_THEMIS_REST_URL;
    try {
      const dial = new LiveChaosDial({ themisUrl: "http://themis:8200" });
      const out = await dial.admit(OPS, "notes");
      expect(out.admitted).toBe(true);
      expect(seen.map((s) => s.url)).toEqual(["http://themis:8200/mcp"]);
    } finally {
      if (prev !== undefined) process.env.CALLIOPE_THEMIS_REST_URL = prev;
    }
  });
});
