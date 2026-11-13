/**
 * LiveChaosDial through an injected fetch: how it reads every REST answer
 * shape (refusal, text, structured content, the {result} wrapper), endpoint
 * resolution, and admit's argument and result shaping over themis's REST
 * door. Nothing leaves the process.
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChaosClientError, LiveChaosDial } from "../src/chaos-client.js";
import type { ChaosRest, ChaosRestAnswer } from "../src/chaos-rest.js";
import { CHAOS_DOC } from "./helpers/chaos-door.js";

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
    const star = new URL(url).hostname.startsWith("themis")
      ? "themis"
      : "chaos";
    return Promise.resolve(handler(call)).then((res) => {
      const headers = new Headers(res.headers);
      headers.set("X-Star", star);
      return new Response(res.body, { status: res.status, headers });
    });
  }) as unknown as typeof fetch;
}

/** The verb (from /v1/<verb>) and the JSON arguments of a REST call. */
function rpcOf(c: Call): RpcBody {
  const verb = new URL(c.url).pathname.replace(/^\/v1\//, "");
  return {
    params: {
      name: verb,
      arguments: (c.body === "" ? {} : JSON.parse(c.body)) as Record<
        string,
        unknown
      >,
    },
  };
}

/** A structured answer in the result envelope. */
function mcp(structured: unknown): Response {
  return envelope(structured);
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
    themisUrl: "http://themis:8203",
    chaosUrl: "http://chaos:8209",
  });
}

function fakeRest(answer: ChaosRestAnswer): ChaosRest {
  return {
    call: () => Promise.resolve(answer),
  } as unknown as ChaosRest;
}

describe("the verbs on the wire", () => {
  it("posts every verb to its own /v1 path", async () => {
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
    expect(calls.map((c) => rpcOf(c).params.name)).toEqual([
      "admit",
      "find_by_name",
      "resolve_nodes",
      "resolve_node_refs",
      "resolve_node_refs",
      "find_by_value",
      "materialize_edges",
      "materialize_edges",
      "quads_to",
      "register_graph",
      "quads_from",
      "resolve_scalars",
      "history",
      "held_blobs",
    ]);
  });
});

describe("the {result} wrapper", () => {
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

describe("endpoints — base URLs", () => {
  it.each([
    ["http://themis-x:8203///", "http://themis-x:8203/v1/admit"],
    ["http://themis-x:8203", "http://themis-x:8203/v1/admit"],
  ])("themis %s dials %s", async (given, want) => {
    install(() => envelope({ admitted: true }));
    await new LiveChaosDial({ themisUrl: given }).admit([], "s");
    expect(calls.map((c) => c.url)).toEqual([want]);
  });

  it("chaos http://chaos-x:8209// dials /v1/<verb> on that base", async () => {
    install(() => envelope([], "", "chaos"));
    await new LiveChaosDial({ chaosUrl: "http://chaos-x:8209//" }).findByName(
      "k",
      "l",
    );
    expect(calls.map((c) => c.url)).toEqual([
      "http://chaos-x:8209/v1/find_by_name",
    ]);
  });

  it("with no URL given, the REST env then the defaults decide", async () => {
    install((c) =>
      c.url.includes("themis") ? envelope({ admitted: true }) : envelope([]),
    );
    await new LiveChaosDial().admit([], "s");
    await new LiveChaosDial().findByName("k", "l");
    process.env.CALLIOPE_THEMIS_REST_URL = "http://themis-r:8203/";
    process.env.CALLIOPE_CHAOS_REST_URL = "http://chaos-r:8209";
    await new LiveChaosDial().admit([], "s");
    await new LiveChaosDial().findByName("k", "l");
    expect(calls.map((c) => c.url)).toEqual([
      "http://themis/v1/admit",
      "http://chaos/v1/find_by_name",
      "http://themis-r:8203/v1/admit",
      "http://chaos-r:8209/v1/find_by_name",
    ]);
  });

  it("an explicit chaosUrl never inherits the cluster's chaos base", async () => {
    install(() => envelope([], "", "chaos"));
    process.env.CALLIOPE_CHAOS_REST_URL = "http://chaos-r:8209";
    await new LiveChaosDial({ chaosUrl: "http://chaos:8209" }).findByName(
      "k",
      "l",
    );
    expect(calls.map((c) => c.url)).toEqual([
      "http://chaos:8209/v1/find_by_name",
    ]);
  });

  it("an explicit themisUrl never inherits the themis base", async () => {
    install(() => envelope({ admitted: true }));
    process.env.CALLIOPE_THEMIS_REST_URL = "http://themis-r:8203";
    await new LiveChaosDial({ themisUrl: "http://themis:8203" }).admit([], "s");
    expect(calls.map((c) => c.url)).toEqual(["http://themis:8203/v1/admit"]);
  });

  it("a blank REST base is no REST base", async () => {
    install(() => envelope({ admitted: true }));
    await new LiveChaosDial({ themisRestUrl: "   " }).admit([], "s");
    expect(calls.map((c) => c.url)).toEqual(["http://themis/v1/admit"]);
  });

  it("every trailing slash of a REST base is dropped", async () => {
    install(() => envelope({ admitted: true }));
    await new LiveChaosDial({
      themisRestUrl: "  http://themis-r2:8203///  ",
    }).admit([], "s");
    expect(calls.map((c) => c.url)).toEqual(["http://themis-r2:8203/v1/admit"]);
  });
});

describe("admit — arguments and result", () => {
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

  it("a transport failure is rethrown as itself, never retried", async () => {
    install(() => Promise.reject(new Error("boom")));
    const err = await rest()
      .admit(OPS, "s")
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ChaosClientError);
    expect((err as Error).message).toBe("boom");
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
