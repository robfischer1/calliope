/**
 * Findability F4 (spec 034) — the eros-routed pg arm: envelope mapping,
 * source filter on the wire, k pass-through, dark on unreachable/refused.
 * The provider speaks eros's openapi-http face (POST /v1/search, mesh
 * identity stamped by the proxy); fetch is stubbed, nothing leaves the
 * process.
 */
import { describe, expect, it } from "vitest";

import {
  ErosSearchProvider,
  erosUrl,
  makeErosProvider,
} from "../src/eros-provider.js";

const ENVELOPE = "application/vnd.stellar.result+json";

/** The slice of eros's /openapi.json the REST client needs for `search`. */
const DOC = JSON.stringify({
  info: { title: "eros", version: "v1" },
  openapi: "3.1.0",
  paths: {
    "/v1/search": {
      post: {
        operationId: "search",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/x-mcp-tools/search/inputSchema" },
            },
          },
        },
        responses: { "200": { description: "the tool result's text" } },
        "x-mcp-match": {},
        "x-mcp-safe": true,
        "x-mcp-tool": "search",
      },
    },
  },
  "x-mcp-tools": {
    search: {
      annotations: { readOnlyHint: true },
      description: "search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
});

interface Seen {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

/** A stub eros door: the document, then `search` answered by answer(). */
function door(answer: () => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fake = (input: string, init?: RequestInit): Promise<Response> => {
    if (new URL(input).pathname === "/openapi.json") {
      return Promise.resolve(
        new Response(DOC, {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Star": "eros" },
        }),
      );
    }
    const raw = typeof init?.body === "string" ? init.body : "{}";
    seen.push({
      method: init?.method ?? "GET",
      url: input,
      body: JSON.parse(raw) as Record<string, unknown>,
    });
    return Promise.resolve(answer());
  };
  return { fetch: fake as unknown as typeof fetch, seen };
}

function structured(results: Record<string, unknown>[]): Response {
  return new Response(
    JSON.stringify({ text: "", structuredContent: { results } }),
    {
      status: 200,
      headers: { "Content-Type": ENVELOPE, "X-Star": "eros" },
    },
  );
}

describe("ErosSearchProvider", () => {
  it("maps eros hits to the ruled envelope with the source filter on the wire", async () => {
    const d = door(() =>
      structured([
        {
          doc_id: 1,
          source_id: 42,
          title: "The Note",
          snippet: "matched text",
          score: 0.031,
          source_table: "calliope_documents",
        },
        { doc_id: 2, source_id: 43, title: null, snippet: "bare", score: 0.02 },
      ]),
    );
    const provider = new ErosSearchProvider("http://eros:8203", d.fetch);
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
    expect(d.seen).toHaveLength(1);
    expect(d.seen[0]?.method).toBe("POST");
    expect(d.seen[0]?.url).toBe("http://eros:8203/v1/search");
    expect(d.seen[0]?.body).toMatchObject({
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

  it("degrades to a dark arm when the door refuses the verb", async () => {
    const d = door(
      () =>
        new Response(JSON.stringify({ code: "forbidden", detail: "no" }), {
          status: 403,
          headers: { "Content-Type": "application/json", "X-Star": "eros" },
        }),
    );
    const res = await new ErosSearchProvider(
      "http://eros:8203",
      d.fetch,
    ).search("x");
    expect(res.armsDark).toEqual(["eros"]);
    expect(res.armsQueried).toEqual([]);
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
