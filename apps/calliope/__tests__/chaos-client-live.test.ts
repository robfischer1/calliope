/**
 * LiveChaosDial through an injected fetch: the JSON-RPC envelope it sends, how
 * it reads every answer shape (error body, refusal, text blocks, structured
 * content, the {result} wrapper), the timeout, endpoint and REST-flip
 * resolution, and admit's argument and result shaping over both MCP and
 * themis's REST door. Pinned against the surviving mutants; nothing leaves the
 * process.
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChaosClientError, LiveChaosDial } from "../src/chaos-client.js";
import type { ChaosRest, ChaosRestAnswer } from "../src/chaos-rest.js";

const CHAOS_DOC = readFileSync(
  new URL("./fixtures/chaos-openapi-subset.json", import.meta.url),
  "utf8",
);
const THEMIS_DOC = readFileSync(
  new URL("./fixtures-themis-admit-openapi.json", import.meta.url),
  "utf8",
);
const ENVELOPE = "application/vnd.stellar.result+json";
const TOKEN = "a".repeat(64);

interface Call {
  url: string;
  method: string;
  rawHeaders: unknown;
  body: string;
  signal: AbortSignal | null | undefined;
  hasTls: boolean;
}

interface RpcBody {
  jsonrpc: string;
  id: number;
  method: string;
  params: { name: string; arguments: Record<string, unknown> };
}

let calls: Call[] = [];
const realFetch = globalThis.fetch;

type Handler = (c: Call) => Response | Promise<Response>;

function install(handler: Handler): void {
  calls = [];
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    const url = input;
    if (url.endsWith("/openapi.json")) {
      const themis = new URL(url).hostname.startsWith("themis");
      return Promise.resolve(
        new Response(themis ? THEMIS_DOC : CHAOS_DOC, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "X-Star": themis ? "themis" : "chaos",
          },
        }),
      );
    }
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      rawHeaders: init?.headers,
      body: typeof init?.body === "string" ? init.body : "",
      signal: init?.signal,
      hasTls: init !== undefined && "tls" in init,
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as unknown as typeof fetch;
}

function rpcOf(c: Call): RpcBody {
  return JSON.parse(c.body) as RpcBody;
}

function mcp(structured: unknown): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { structuredContent: structured },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function mcpRaw(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function envelope(
  structured: unknown,
  text = "",
  star = "themis",
  status = 200,
): Response {
  return new Response(JSON.stringify({ text, structuredContent: structured }), {
    status,
    headers: { "Content-Type": ENVELOPE, "X-Star": star },
  });
}

function plain(status: number, body: string, star = "themis"): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", "X-Star": star },
  });
}

const ENV_KEYS = [
  "CALLIOPE_THEMIS_URL",
  "CALLIOPE_CHAOS_URL",
  "CHAOS_URL",
  "CALLIOPE_CHAOS_REST_URL",
  "CALLIOPE_THEMIS_REST_URL",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) savedEnv[k] = v;
    Reflect.deleteProperty(process.env, k);
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    Reflect.deleteProperty(process.env, k);
    const v = savedEnv[k];
    if (v !== undefined) process.env[k] = v;
  }
});

function mcpDial(): LiveChaosDial {
  return new LiveChaosDial({
    themisUrl: "http://themis:8200",
    chaosUrl: "http://chaos:8206",
  });
}

function fakeRest(answer: ChaosRestAnswer): ChaosRest {
  return {
    serves: () => true,
    call: () => Promise.resolve(answer),
  } as unknown as ChaosRest;
}

describe("rpc — the JSON-RPC envelope on the wire", () => {
  it("posts one tools/call with the advertised framings", async () => {
    install(() => mcp([]));
    await mcpDial().findByName("Note", "x");
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c?.url).toBe("http://chaos:8206/mcp");
    expect(c?.method).toBe("POST");
    expect(c?.rawHeaders).toStrictEqual({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    });
    expect(JSON.parse(c?.body ?? "")).toStrictEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "find_by_name", arguments: { kind: "Note", label: "x" } },
    });
    expect(c?.signal).toBeInstanceOf(AbortSignal);
    expect(c?.hasTls).toBe(false);
  });

  it("numbers every call in order and names each verb", async () => {
    install((c) => {
      const name = rpcOf(c).params.name;
      if (name === "held_blobs") return mcp({ held: [] });
      if (name === "admit") return mcp({ admitted: true });
      if (name === "resolve_node_refs") {
        return mcp(
          rpcOf(c).params.arguments.missing_ok === true
            ? { refs: [], missing: [] }
            : {},
        );
      }
      return mcp([]);
    });
    const d = mcpDial();
    await d.admit([], "s");
    await d.findByName("k", "l");
    await d.resolveNodes([TOKEN]);
    await d.resolveNodeRefs([TOKEN]);
    await d.resolveRefsEcho([TOKEN]);
    await d.findByValue("g", "p", "v");
    await d.edges(TOKEN);
    await d.placedEdges(TOKEN);
    await d.referrers(TOKEN);
    await d.registerGraph("g");
    await d.quadsFrom([TOKEN], null, null);
    await d.resolveScalars([TOKEN]);
    await d.history([TOKEN], []);
    await d.heldBlobs();
    expect(calls.map((c) => [rpcOf(c).id, rpcOf(c).params.name])).toEqual([
      [1, "admit"],
      [2, "find_by_name"],
      [3, "resolve_nodes"],
      [4, "resolve_node_refs"],
      [5, "resolve_node_refs"],
      [6, "find_by_value"],
      [7, "materialize_edges"],
      [8, "materialize_edges"],
      [9, "quads_to"],
      [10, "register_graph"],
      [11, "quads_from"],
      [12, "resolve_scalars"],
      [13, "history"],
      [14, "held_blobs"],
    ]);
  });
});

describe("rpc — timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts the request at 30 seconds, not before", async () => {
    vi.useFakeTimers();
    const seen: { signal?: AbortSignal | null } = {};
    globalThis.fetch = ((_u: string, init?: RequestInit) => {
      seen.signal = init?.signal;
      return new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          rej(new Error("aborted"));
        });
      });
    }) as unknown as typeof fetch;
    const pending = mcpDial()
      .findByName("Note", "x")
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(seen.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.signal?.aborted).toBe(true);
    expect(((await pending) as Error).message).toBe("aborted");
  });

  it("clears its timer once the call settles", async () => {
    vi.useFakeTimers();
    install(() => mcp([]));
    await mcpDial().findByName("Note", "x");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("rpc — reading the answer", () => {
  it("a JSON-RPC error body is thrown with its verb and the error", async () => {
    install(() =>
      mcpRaw({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "bad" } }),
    );
    const err = await mcpDial()
      .findByName("Note", "x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChaosClientError);
    expect((err as ChaosClientError).message).toBe(
      'find_by_name: {"code":-1,"message":"bad"}',
    );
    expect((err as ChaosClientError).code).toBe("wire_error");
  });

  it("an answer with no result is an empty read, not a crash", async () => {
    install(() => mcpRaw({ jsonrpc: "2.0", id: 1 }));
    expect(await mcpDial().findByName("Note", "x")).toStrictEqual([]);
  });

  it("an isError result with no refusal body keeps the raw content", async () => {
    install(() =>
      mcpRaw({
        jsonrpc: "2.0",
        id: 1,
        result: { isError: true, content: [{ type: "text", text: "boom" }] },
      }),
    );
    const err = await mcpDial()
      .findByName("Note", "x")
      .catch((e: unknown) => e);
    expect((err as ChaosClientError).message).toBe(
      'find_by_name: [{"type":"text","text":"boom"}]',
    );
    expect((err as ChaosClientError).code).toBe("wire_error");
  });

  it("an isError refusal that is not a conflict stays a wire error", async () => {
    const content = [
      { type: "text", text: JSON.stringify({ code: "denied", detail: "no" }) },
    ];
    install(() =>
      mcpRaw({ jsonrpc: "2.0", id: 1, result: { isError: true, content } }),
    );
    const err = await mcpDial()
      .findByName("Note", "x")
      .catch((e: unknown) => e);
    expect((err as ChaosClientError).code).toBe("wire_error");
    expect((err as ChaosClientError).message).toBe(
      `find_by_name: ${JSON.stringify(content)}`,
    );
  });

  it("a conflict refusal in a text block is the registered conflict", async () => {
    install(() =>
      mcpRaw({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ code: "conflict", detail: "held" }),
            },
          ],
        },
      }),
    );
    const err = await mcpDial()
      .admit([], "s")
      .catch((e: unknown) => e);
    expect((err as ChaosClientError).code).toBe("conflict");
    expect((err as ChaosClientError).message).toBe("admit: conflict: held");
  });

  it("a conflict in structuredContent is read when no text block carries it", async () => {
    install(() =>
      mcpRaw({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [],
          structuredContent: { code: "conflict", detail: "d" },
        },
      }),
    );
    const err = await mcpDial()
      .admit([], "s")
      .catch((e: unknown) => e);
    expect((err as ChaosClientError).code).toBe("conflict");
  });

  it("a result with only text blocks is parsed from them", async () => {
    install(() =>
      mcpRaw({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: JSON.stringify([TOKEN, "junk"]) }],
        },
      }),
    );
    expect(await mcpDial().findByName("Note", "x")).toStrictEqual([TOKEN]);
  });
});

describe("the {result} wrapper — one reader over MCP and REST", () => {
  const SHAPES: [string, unknown, Record<string, string>][] = [
    ["unwraps a lone {result}", { result: { k: "v" } }, { k: "v" }],
    [
      "keeps a {result} that has company",
      { result: 1, x: 2 },
      { result: "1", x: "2" },
    ],
    ["keeps a lone key that is not result", { a: 1 }, { a: "1" }],
    ["leaves null as null", null, {}],
    ["leaves a bare string alone", "a", {}],
  ];

  it.each(SHAPES)("MCP: %s", async (_name, structured, want) => {
    install(() => mcp(structured));
    expect(await mcpDial().resolveNodes([TOKEN])).toStrictEqual(want);
  });

  it.each(SHAPES)("REST: %s", async (_name, structured, want) => {
    const dial = new LiveChaosDial({
      chaosRest: fakeRest({
        ok: true,
        reply: { texts: [], structured },
      }),
    });
    expect(await dial.resolveNodes([TOKEN])).toStrictEqual(want);
  });

  it("REST: text blocks stand in when no structured content rode", async () => {
    const dial = new LiveChaosDial({
      chaosRest: fakeRest({
        ok: true,
        reply: { texts: ['{"k":"v"}'], structured: undefined },
      }),
    });
    expect(await dial.resolveNodes([TOKEN])).toStrictEqual({ k: "v" });
  });

  it("REST: a refusal that is not a conflict carries the star's text", async () => {
    const dial = new LiveChaosDial({
      chaosRest: fakeRest({
        ok: false,
        refusal: { code: "denied", detail: "d", text: "THE TEXT" },
      }),
    });
    const err = await dial.findByName("k", "l").catch((e: unknown) => e);
    expect((err as ChaosClientError).code).toBe("wire_error");
    expect((err as ChaosClientError).message).toBe("find_by_name: THE TEXT");
  });

  it("REST: a conflict refusal is typed and carries its detail", async () => {
    const dial = new LiveChaosDial({
      chaosRest: fakeRest({
        ok: false,
        refusal: { code: "conflict", detail: "held", text: "T" },
      }),
    });
    const err = await dial.findByName("k", "l").catch((e: unknown) => e);
    expect((err as ChaosClientError).code).toBe("conflict");
    expect((err as ChaosClientError).message).toBe(
      "find_by_name: conflict: held",
    );
  });
});

describe("endpoints — URL normalising and the REST flips", () => {
  it.each([
    ["http://themis:8200///", "http://themis:8200/mcp"],
    ["http://themis:8200", "http://themis:8200/mcp"],
    ["http://themis:8200/mcp", "http://themis:8200/mcp"],
    ["http://themis:8200/mcp/", "http://themis:8200/mcp"],
  ])("themis %s dials %s", async (given, want) => {
    install(() => mcp({ admitted: true }));
    await new LiveChaosDial({ themisUrl: given }).admit([], "s");
    expect(calls.map((c) => c.url)).toEqual([want]);
  });

  it.each([
    ["http://chaos:8206//", "http://chaos:8206/mcp"],
    ["http://chaos:8206", "http://chaos:8206/mcp"],
    ["http://chaos:8206/mcp", "http://chaos:8206/mcp"],
    ["http://chaos:8206/mcp/", "http://chaos:8206/mcp"],
  ])("chaos %s dials %s", async (given, want) => {
    install(() => mcp([]));
    await new LiveChaosDial({ chaosUrl: given }).findByName("k", "l");
    expect(calls.map((c) => c.url)).toEqual([want]);
  });

  it("with no URL given, the env then the defaults decide", async () => {
    install((c) =>
      c.url.includes("themis") ? mcp({ admitted: true }) : mcp([]),
    );
    await new LiveChaosDial().admit([], "s");
    await new LiveChaosDial().findByName("k", "l");
    process.env.CALLIOPE_THEMIS_URL = "http://themis-env:1/";
    process.env.CHAOS_URL = "http://chaos-legacy:2/";
    await new LiveChaosDial().admit([], "s");
    await new LiveChaosDial().findByName("k", "l");
    process.env.CALLIOPE_CHAOS_URL = "http://chaos-env:3";
    await new LiveChaosDial().findByName("k", "l");
    expect(calls.map((c) => c.url)).toEqual([
      "http://themis:8203/mcp",
      "http://chaos:8209/mcp",
      "http://themis-env:1/mcp",
      "http://chaos-legacy:2/mcp",
      "http://chaos-env:3/mcp",
    ]);
  });

  function door(): void {
    install((c) => {
      if (c.url.endsWith("/mcp")) {
        return mcp(rpcOf(c).params.name === "admit" ? { admitted: true } : []);
      }
      if (c.url.includes("/v1/admit")) {
        return envelope({ admitted: true, minted: [] });
      }
      return envelope([], "", "chaos");
    });
  }

  it("CALLIOPE_CHAOS_REST_URL flips chaos reads to REST when no chaosUrl is given", async () => {
    door();
    process.env.CALLIOPE_CHAOS_REST_URL = "http://chaos-r:8209";
    await new LiveChaosDial().findByName("k", "l");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/^http:\/\/chaos-r:8209\/v1\/find_by_name\?/);
  });

  it("an explicit chaosUrl never inherits the cluster's REST flip", async () => {
    door();
    process.env.CALLIOPE_CHAOS_REST_URL = "http://chaos-r:8209";
    await new LiveChaosDial({ chaosUrl: "http://chaos:8206" }).findByName(
      "k",
      "l",
    );
    expect(calls.map((c) => c.url)).toEqual(["http://chaos:8206/mcp"]);
  });

  it("with no flip and no URL, chaos reads stay on /mcp", async () => {
    door();
    await new LiveChaosDial().findByName("k", "l");
    expect(calls.map((c) => c.url)).toEqual(["http://chaos:8209/mcp"]);
  });

  it("CALLIOPE_THEMIS_REST_URL moves admit to REST when no themisUrl is given", async () => {
    door();
    process.env.CALLIOPE_THEMIS_REST_URL = "http://themis-r:8203";
    await new LiveChaosDial().admit([], "s");
    expect(calls.map((c) => c.url)).toEqual(["http://themis-r:8203/v1/admit"]);
  });

  it("an explicit themisUrl never inherits the themis REST flip", async () => {
    door();
    process.env.CALLIOPE_THEMIS_REST_URL = "http://themis-r:8203";
    await new LiveChaosDial({ themisUrl: "http://themis:8200" }).admit([], "s");
    expect(calls.map((c) => c.url)).toEqual(["http://themis:8200/mcp"]);
  });

  it("a blank REST base is no REST base", async () => {
    door();
    await new LiveChaosDial({
      themisUrl: "http://themis:8200",
      themisRestUrl: "   ",
    }).admit([], "s");
    process.env.CALLIOPE_THEMIS_REST_URL = "   ";
    await new LiveChaosDial().admit([], "s");
    expect(calls.map((c) => c.url)).toEqual([
      "http://themis:8200/mcp",
      "http://themis:8203/mcp",
    ]);
  });

  it("every trailing slash of a REST base is dropped", async () => {
    door();
    await new LiveChaosDial({
      themisUrl: "http://themis:8200",
      themisRestUrl: "  http://themis-r2:8203///  ",
    }).admit([], "s");
    expect(calls.map((c) => c.url)).toEqual(["http://themis-r2:8203/v1/admit"]);
  });
});

describe("admit — arguments and result over MCP", () => {
  const OPS = [{ op: "createNode", kind: "Note", label: "n" }];
  const EXPECT = [{ s: "a", predicate: "p", held: [{ literal: "x" }] }];

  it("sends expect only when there is at least one", async () => {
    install(() => mcp({ admitted: true }));
    const d = mcpDial();
    await d.admit(OPS, "s");
    await d.admit(OPS, "s", []);
    await d.admit(OPS, "s", EXPECT);
    expect(calls.map((c) => rpcOf(c).params.arguments)).toStrictEqual([
      { ops: OPS, scope: "s" },
      { ops: OPS, scope: "s" },
      { ops: OPS, scope: "s", expect: EXPECT },
    ]);
  });

  it("an answer naming nothing is a refusal with empty lists", async () => {
    install(() => mcp({}));
    expect(await mcpDial().admit(OPS, "s")).toStrictEqual({
      admitted: false,
      minted: [],
      violations: [],
    });
  });

  it("ok stands in for admitted, which wins when both are stated", async () => {
    install(() => mcp({ ok: true }));
    expect((await mcpDial().admit(OPS, "s")).admitted).toBe(true);
    install(() => mcp({ admitted: false, ok: true }));
    expect((await mcpDial().admit(OPS, "s")).admitted).toBe(false);
  });

  it("minted tokens are stringified, violations kept, tx only when a number", async () => {
    install(() =>
      mcp({ admitted: true, minted: [1, "b"], violations: [{ v: 1 }], tx: 5 }),
    );
    expect(await mcpDial().admit(OPS, "s")).toStrictEqual({
      admitted: true,
      minted: ["1", "b"],
      violations: [{ v: 1 }],
      tx: 5,
    });
    install(() => mcp({ admitted: true, tx: "5" }));
    expect(await mcpDial().admit(OPS, "s")).toStrictEqual({
      admitted: true,
      minted: [],
      violations: [],
    });
  });

  it.each([[null], ["x"]])(
    "a non-object answer (%j) is a bad_result",
    async (raw) => {
      install(() => mcp(raw));
      const err = await mcpDial()
        .admit(OPS, "s")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChaosClientError);
      expect((err as ChaosClientError).message).toBe("admit: empty result");
      expect((err as ChaosClientError).code).toBe("bad_result");
    },
  );
});

describe("admit — over themis's REST door", () => {
  const OPS = [{ op: "createNode", kind: "Note", label: "n" }];
  const rest = (base = "http://themis-r:8203"): LiveChaosDial =>
    new LiveChaosDial({ themisUrl: "http://themis:8200", themisRestUrl: base });

  it("hands the call a timeout signal", async () => {
    install(() => envelope({ admitted: true }));
    await rest().admit(OPS, "s");
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("text stands in when structured content is null", async () => {
    install(() => envelope(null, '{"admitted":true,"minted":[7]}'));
    expect(await rest().admit(OPS, "s")).toStrictEqual({
      admitted: true,
      minted: ["7"],
      violations: [],
    });
  });

  it("text stands in when no envelope rode", async () => {
    install(() => plain(200, '{"admitted":true}'));
    expect((await rest().admit(OPS, "s")).admitted).toBe(true);
  });

  it("no text and no structured content is an empty result, not a parse error", async () => {
    for (const reply of [
      plain(200, ""),
      envelope(null),
      envelope({ result: null }),
    ]) {
      install(() => reply.clone());
      const err = await rest()
        .admit(OPS, "s")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChaosClientError);
      expect((err as ChaosClientError).code).toBe("bad_result");
      expect((err as ChaosClientError).message).toBe("admit: empty result");
    }
  });

  it("unwraps a lone {result} and nothing else", async () => {
    install(() => envelope({ result: { admitted: true, minted: ["m"] } }));
    expect((await rest().admit(OPS, "s")).minted).toEqual(["m"]);
    install(() => envelope({ result: { admitted: true }, extra: 1 }));
    expect((await rest().admit(OPS, "s")).admitted).toBe(false);
    install(() => envelope({ admitted: true }));
    expect((await rest().admit(OPS, "s")).admitted).toBe(true);
  });

  it("a bare string is no object", async () => {
    install(() => envelope("a"));
    const err = await rest()
      .admit(OPS, "s")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChaosClientError);
    expect((err as ChaosClientError).code).toBe("bad_result");
  });

  it("a conflict refusal carries its detail; another refusal carries the star's text", async () => {
    install(() =>
      plain(409, JSON.stringify({ code: "conflict", detail: "slot held" })),
    );
    const conflict = await rest()
      .admit(OPS, "s")
      .catch((e: unknown) => e);
    expect((conflict as ChaosClientError).code).toBe("conflict");
    expect((conflict as ChaosClientError).message).toBe(
      "admit: conflict: slot held",
    );
    const body = JSON.stringify({ code: "denied", detail: "no grant" });
    install(() => plain(403, body));
    const denied = await rest()
      .admit(OPS, "s")
      .catch((e: unknown) => e);
    expect((denied as ChaosClientError).code).toBe("wire_error");
    expect((denied as ChaosClientError).message).toBe(`admit: ${body}`);
  });

  it("a transport failure is rethrown as itself, never re-sent over MCP", async () => {
    install(() => Promise.reject(new Error("boom")));
    const err = await rest()
      .admit(OPS, "s")
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ChaosClientError);
    expect((err as Error).message).toBe("boom");
    expect(calls.some((c) => c.url.endsWith("/mcp"))).toBe(false);
  });

  it("a door whose document cannot be read falls back to MCP", async () => {
    globalThis.fetch = ((input: string, init?: RequestInit) => {
      const url = input;
      calls.push({
        url,
        method: init?.method ?? "GET",
        rawHeaders: init?.headers,
        body: typeof init?.body === "string" ? init.body : "",
        signal: init?.signal,
        hasTls: false,
      });
      return Promise.resolve(
        url.endsWith("/openapi.json")
          ? new Response("gone", { status: 404 })
          : mcp({ admitted: true }),
      );
    }) as unknown as typeof fetch;
    calls = [];
    const out = await new LiveChaosDial({
      themisUrl: "http://themis-nodoc:8200",
      themisRestUrl: "http://themis-nodoc:8203",
    }).admit(OPS, "s");
    expect(out.admitted).toBe(true);
    expect(calls.at(-1)?.url).toBe("http://themis-nodoc:8200/mcp");
  });
});

describe("chaos reads — argument and row shaping", () => {
  it("quadsFrom sends names, tx and graph; nulls when absent", async () => {
    install(() => mcp([]));
    const d = mcpDial();
    await d.quadsFrom(["s"], 5, ["p"], "g");
    await d.quadsFrom(["s"], null, null);
    expect(calls.map((c) => rpcOf(c).params.arguments)).toStrictEqual([
      { subjects: ["s"], as_of_tx: 5, predicates: ["p"], graph: "g" },
      { subjects: ["s"], as_of_tx: null, predicates: null, graph: null },
    ]);
  });

  it("quadsFrom keeps only 4-wide array rows, coerced to strings", async () => {
    install(() =>
      mcp([
        [1, "p", true, null],
        ["a", "b", "c"],
        "abcd",
        ["s", "p", "o", "g", "extra"],
      ]),
    );
    expect(await mcpDial().quadsFrom(["s"], null, null)).toStrictEqual([
      { s: "1", p: "p", o: "true", g: "" },
      { s: "s", p: "p", o: "o", g: "g" },
    ]);
  });

  it("quadsFrom answers empty to a reply that is not a row list", async () => {
    install(() => mcp({}));
    expect(await mcpDial().quadsFrom(["s"], null, null)).toStrictEqual([]);
  });

  it("history and heldBlobs send a null graph when none is named", async () => {
    install((c) =>
      mcp(
        rpcOf(c).params.name === "held_blobs"
          ? { held: [] }
          : { transactions: [] },
      ),
    );
    const d = mcpDial();
    await d.history(["s"], ["f"]);
    await d.history(["s"], ["f"], "g");
    await d.heldBlobs();
    await d.heldBlobs("g");
    expect(calls.map((c) => rpcOf(c).params.arguments)).toStrictEqual([
      { subjects: ["s"], follow: ["f"], graph: null },
      { subjects: ["s"], follow: ["f"], graph: "g" },
      { graph: null },
      { graph: "g" },
    ]);
  });
});
