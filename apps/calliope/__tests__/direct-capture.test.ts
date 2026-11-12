/**
 * CALLIOPE_DIRECT_CAPTURE — the strangler flag that moves LiveChaosDial.admit
 * from themis `admit` to ONE chaos `capture`. BLIND tests, written from the
 * contract and from themis's ToWire/opsFromWire (origin/main), not from any
 * implementation. Golden ops are spelled out by hand; hashes are computed here
 * with node:crypto (sha256 value 0x1f dtype 0x1f lang), never via calliope.
 *
 * Seams the builder must match:
 *   - `new LiveChaosDial({ directCapture: boolean })` overrides the env flag;
 *     absent, `CALLIOPE_DIRECT_CAPTURE === "on"` (read only when no themisUrl /
 *     chaosUrl was passed, like CALLIOPE_THEMIS_REST_URL) decides.
 *   - the capture rides the dial's `chaosRest` (a ChaosRest) as POST /v1/capture.
 */
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ChaosClientError,
  LiveChaosDial,
  opAdd,
  opCreate,
  opRemove,
  type ChaosExpect,
  type ChaosOp,
} from "../src/chaos-client.js";
import { ChaosRest } from "../src/chaos-rest.js";
import { LocalChaosDial } from "../src/local-admit.js";

type DialOpts = NonNullable<ConstructorParameters<typeof LiveChaosDial>[0]>;
const opts = (o: Record<string, unknown>): DialOpts => o;

const ENVELOPE = "application/vnd.stellar.result+json";
const sha = (v: string, dtype = "", lang = ""): string =>
  createHash("sha256").update(`${v}\x1f${dtype}\x1f${lang}`).digest("hex");

const CAPTURE_DOC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "chaos", version: "v1" },
  paths: {
    "/v1/capture": {
      post: {
        operationId: "capture",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/x-mcp-tools/capture/inputSchema" },
            },
          },
        },
        responses: { "200": { description: "ok" } },
        "x-mcp-match": {},
        "x-mcp-safe": false,
        "x-mcp-tool": "capture",
      },
    },
  },
  "x-mcp-tools": {
    capture: {
      annotations: { idempotentHint: false, readOnlyHint: false },
      description: "capture",
      inputSchema: { type: "object", additionalProperties: true },
      name: "capture",
    },
  },
});

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

type Answer = () => Response | Promise<Response>;

function chaosDoor(answer: Answer): { rest: ChaosRest; seen: Seen[] } {
  const seen: Seen[] = [];
  const fake = (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    if (path === "/openapi.json") {
      return Promise.resolve(
        new Response(CAPTURE_DOC, {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Star": "chaos" },
        }),
      );
    }
    seen.push({
      method: init?.method ?? "GET",
      path,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null,
    });
    return Promise.resolve(answer());
  };
  return {
    rest: new ChaosRest("http://chaos:8209", 5_000, fake as typeof fetch),
    seen,
  };
}

const ok =
  (value: unknown = { tx: 9, results: [] }): Answer =>
  () =>
    new Response(JSON.stringify({ text: "", structuredContent: value }), {
      status: 200,
      headers: { "Content-Type": ENVELOPE, "X-Star": "chaos" },
    });

const refuse =
  (code: string, detail: string, status = 422): Answer =>
  () =>
    new Response(JSON.stringify({ code, detail }), {
      status,
      headers: { "Content-Type": "application/json", "X-Star": "chaos" },
    });

// Everything that is NOT the chaos door: themis REST / MCP ride globalThis.fetch.
interface Themis {
  url: string;
  body: string;
}
let themis: Themis[] = [];
const realFetch = globalThis.fetch;
const realFlag = process.env.CALLIOPE_DIRECT_CAPTURE;
const realRest = process.env.CALLIOPE_THEMIS_REST_URL;

beforeEach(() => {
  themis = [];
  delete process.env.CALLIOPE_DIRECT_CAPTURE;
  delete process.env.CALLIOPE_THEMIS_REST_URL;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    themis.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
    });
    const h = { "content-type": "application/json", "X-Star": "themis" };
    if (url.endsWith("/openapi.json")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            openapi: "3.1.0",
            info: { title: "themis", version: "v1" },
            paths: {
              "/v1/admit": {
                post: {
                  operationId: "admit",
                  requestBody: {
                    content: {
                      "application/json": {
                        schema: { $ref: "#/x-mcp-tools/admit/inputSchema" },
                      },
                    },
                  },
                  responses: { "200": { description: "ok" } },
                  "x-mcp-match": {},
                  "x-mcp-tool": "admit",
                },
              },
            },
            "x-mcp-tools": {
              admit: {
                name: "admit",
                inputSchema: { type: "object", additionalProperties: true },
              },
            },
          }),
          { status: 200, headers: h },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ admitted: true, minted: ["m"], tx: 1 }), {
        status: 200,
        headers: h,
      }),
    );
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of [
    ["CALLIOPE_DIRECT_CAPTURE", realFlag],
    ["CALLIOPE_THEMIS_REST_URL", realRest],
  ] as const) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

const NODE = "a".repeat(64);
const dialOn = (door: { rest: ChaosRest }, extra: object = {}): LiveChaosDial =>
  new LiveChaosDial(
    opts({
      themisUrl: "http://themis:8200",
      chaosUrl: "http://chaos:8209",
      chaosRest: door.rest,
      directCapture: true,
      ...extra,
    }),
  );

describe("flag off — exactly today's behaviour (contract 1)", () => {
  it.each([undefined, false] as const)(
    "directCapture=%s with REST themis: one POST /v1/admit, no capture",
    async (flag) => {
      const door = chaosDoor(ok());
      const dial = new LiveChaosDial(
        opts({
          themisUrl: "http://themis:8200",
          themisRestUrl: "http://themis:8203",
          chaosUrl: "http://chaos:8209",
          chaosRest: door.rest,
          ...(flag === undefined ? {} : { directCapture: flag }),
        }),
      );
      const ops = [opCreate("Note", "n")];
      const out = await dial.admit(ops, "notes");
      expect(out.admitted).toBe(true);
      const posts = themis.filter((t) => t.url.endsWith("/v1/admit"));
      expect(posts).toHaveLength(1);
      expect(posts[0]?.url).toBe("http://themis:8203/v1/admit");
      expect(JSON.parse(posts[0]?.body ?? "{}")).toEqual({
        ops,
        scope: "notes",
      });
      expect(door.seen).toHaveLength(0);
    },
  );

  it.each(["off", "true", "1", "yes", "", "ON"])(
    "env CALLIOPE_DIRECT_CAPTURE=%j does not enable (only the word `on` does)",
    async (v) => {
      process.env.CALLIOPE_DIRECT_CAPTURE = v;
      const door = chaosDoor(ok());
      const dial = new LiveChaosDial(opts({ chaosRest: door.rest }));
      await dial.admit([opCreate("Note", "n")], "notes").catch(() => undefined);
      expect(door.seen).toHaveLength(0);
    },
  );
});

describe("flag on — one chaos capture per admit (contract 2)", () => {
  it("env CALLIOPE_DIRECT_CAPTURE=on enables it with no opts flag", async () => {
    process.env.CALLIOPE_DIRECT_CAPTURE = "on";
    const door = chaosDoor(ok());
    const dial = new LiveChaosDial(opts({ chaosRest: door.rest }));
    await dial.admit([opCreate("Note", "n")], "notes");
    expect(door.seen).toHaveLength(1);
    expect(themis).toHaveLength(0);
  });

  it("opts.directCapture=false beats env on", async () => {
    process.env.CALLIOPE_DIRECT_CAPTURE = "on";
    const door = chaosDoor(ok());
    const dial = new LiveChaosDial(
      opts({
        themisUrl: "http://themis:8200",
        chaosUrl: "http://chaos:8209",
        chaosRest: door.rest,
        directCapture: false,
      }),
    );
    await dial.admit([opCreate("Note", "n")], "notes");
    expect(door.seen).toHaveLength(0);
    expect(
      themis.filter((t) => t.url.endsWith("/v1/admit")).map((t) => t.url),
    ).toEqual(["http://themis:8200/v1/admit"]);
  });

  it("posts exactly one /v1/capture {ops, author:'calliope'} and never touches themis", async () => {
    const door = chaosDoor(
      ok({ tx: 9, results: [{ op: "createNode", id: NODE }] }),
    );
    const dial = dialOn(door);
    const out = await dial.admit([opCreate("Note", "n")], "notes");
    expect(door.seen).toHaveLength(1);
    expect(door.seen[0]?.method).toBe("POST");
    expect(door.seen[0]?.path).toBe("/v1/capture");
    expect(door.seen[0]?.body).toEqual({
      ops: [{ op: "createNode", label: "n", kind: "Note" }],
      author: "calliope",
    });
    expect(Object.keys(door.seen[0]?.body ?? {}).sort()).toEqual([
      "author",
      "ops",
    ]);
    expect(themis).toHaveLength(0); // no admit on REST, none on MCP, no openapi probe
    expect(out).toEqual({
      admitted: true,
      minted: [NODE],
      violations: [],
      tx: 9,
    });
  });

  it("scope is required: an empty scope throws and sends nothing", async () => {
    const door = chaosDoor(ok());
    await expect(
      dialOn(door).admit([opCreate("Note", "n")], ""),
    ).rejects.toThrow(/scope/);
    expect(door.seen).toHaveLength(0);
  });

  it("expect rides only when non-empty, verbatim", async () => {
    const door = chaosDoor(ok());
    const dial = dialOn(door);
    const exp: ChaosExpect[] = [
      { s: NODE, predicate: "tree_content", held: [{ $blob: "17" }] },
      { s: NODE, predicate: "status", g: "notes", held: [{ literal: "x" }] },
    ];
    await dial.admit([opCreate("Note", "n")], "notes", []);
    await dial.admit([opCreate("Note", "n")], "notes", undefined);
    await dial.admit([opCreate("Note", "n")], "notes", exp);
    expect(door.seen[0]?.body).not.toHaveProperty("expect");
    expect(door.seen[1]?.body).not.toHaveProperty("expect");
    expect(door.seen[2]?.body?.expect).toEqual(exp);
  });

  it("idempotence: two identical admits are two identical captures, no client state", async () => {
    const door = chaosDoor(ok());
    const dial = dialOn(door);
    const ops = [
      opCreate("Note", "n"),
      opAdd("n", "title", { toLiteral: "t" }),
    ];
    await dial.admit(ops, "notes");
    await dial.admit(ops, "notes");
    expect(door.seen).toHaveLength(2);
    expect(door.seen[1]?.body).toEqual(door.seen[0]?.body);
  });
});

describe("capture ops equal what themis ToWire would send (golden, contract 2)", () => {
  async function wire(ops: ChaosOp[], scope = "moirae"): Promise<unknown> {
    const door = chaosDoor(ok());
    await dialOn(door).admit(ops, scope);
    return door.seen[0]?.body?.ops;
  }

  it("createNode with label + literal edge: intern row before the edge, o = content hash, g = scope, label -> $mint", async () => {
    expect(
      await wire([
        opCreate("Work", "the-card"),
        opAdd("the-card", "status", { toLiteral: "done" }),
      ]),
    ).toEqual([
      { op: "createNode", label: "the-card", kind: "Work" },
      { op: "intern", value: "done" },
      {
        op: "addEdge",
        s: { $mint: 0 },
        predicate: "status",
        o: sha("done"),
        g: "moirae",
      },
    ]);
  });

  it("node edge: $mint for batch labels (first create wins a duplicate), raw token otherwise", async () => {
    expect(
      await wire([
        opCreate("Note", "a"),
        opCreate("Note", "b"),
        opCreate("Note", "a"),
        opAdd("a", "parent", { toNode: "b" }),
        opAdd(NODE, "link", { toNode: "a" }),
        opAdd("unlabelled", "link", { toNode: NODE }),
      ]),
    ).toEqual([
      { op: "createNode", label: "a", kind: "Note" },
      { op: "createNode", label: "b", kind: "Note" },
      { op: "createNode", label: "a", kind: "Note" },
      {
        op: "addEdge",
        s: { $mint: 0 },
        predicate: "parent",
        o: { $mint: 1 },
        g: "moirae",
      },
      {
        op: "addEdge",
        s: NODE,
        predicate: "link",
        o: { $mint: 0 },
        g: "moirae",
      },
      {
        op: "addEdge",
        s: "unlabelled",
        predicate: "link",
        o: NODE,
        g: "moirae",
      },
    ]);
  });

  it("an empty label never names a mint", async () => {
    expect(
      await wire([opCreate("Note", ""), opAdd("", "link", { toNode: NODE })]),
    ).toEqual([
      { op: "createNode", label: "", kind: "Note" },
      { op: "addEdge", s: "", predicate: "link", o: NODE, g: "moirae" },
    ]);
  });

  it("typed literal: interned canonical value with dtype, hash over value+dtype", async () => {
    const micros = String(Date.UTC(2026, 0, 2, 3, 4, 5) * 1000);
    expect(
      await wire([
        opAdd(NODE, "when", {
          toLiteral: "2026-01-02T03:04:05Z",
          dtype: "instant",
        }),
      ]),
    ).toEqual([
      { op: "intern", value: micros, dtype: "instant" },
      {
        op: "addEdge",
        s: NODE,
        predicate: "when",
        o: sha(micros, "instant"),
        g: "moirae",
      },
    ]);
  });

  it("removeEdge with a graph pin lands in that graph; unpinned rides the scope", async () => {
    const pin = "b".repeat(64);
    expect(
      await wire([
        opRemove(NODE, "status", { toLiteral: "old" }, pin),
        opRemove(NODE, "status", { toNode: "c".repeat(64) }),
      ]),
    ).toEqual([
      { op: "intern", value: "old" },
      { op: "removeEdge", s: NODE, predicate: "status", o: sha("old"), g: pin },
      {
        op: "removeEdge",
        s: NODE,
        predicate: "status",
        o: "c".repeat(64),
        g: "moirae",
      },
    ]);
  });

  it("blob edge crosses as {$blob: id}, interns nothing", async () => {
    expect(
      await wire(
        [opAdd(NODE, "tree_content", { toBlob: "9007199254740993" })],
        "notes",
      ),
    ).toEqual([
      {
        op: "addEdge",
        s: NODE,
        predicate: "tree_content",
        o: { $blob: "9007199254740993" },
        g: "notes",
      },
    ]);
  });

  it("relabel is a dictionary op with no graph", async () => {
    expect(await wire([{ op: "relabel", id: NODE, label: "new" }])).toEqual([
      { op: "relabel", id: NODE, label: "new" },
    ]);
  });
});

describe("the admit reply for callers (contract 3)", () => {
  it.each([
    ["cycle guard: depends_on would loop", "depends_on_cycle"],
    ["write permission denied for calliope", "scope"],
    ["predicate not granted to caller", "scope"],
    ["object guard: o is not a node", "spo"],
    ["subject guard: s is a tombstone", "spo"],
    ["cardinality guard: slot already holds one", "cardinality"],
    ["shape: status must match ^(open|done)$", "shape"],
    ["unknown node token zz", "existence"],
    ["no nodes row for s=" + NODE, "existence"],
    ["something nobody classified", "capture_refused"],
  ])(
    "refusal %j -> violation check %s, admitted:false",
    async (detail, check) => {
      const door = chaosDoor(refuse("capture_refused", detail));
      const out = await dialOn(door).admit([opCreate("Note", "n")], "notes");
      expect(out.admitted).toBe(false);
      expect(out.minted).toEqual([]);
      expect(out.violations).toHaveLength(1);
      const v = out.violations[0] as { check: string; detail: string };
      expect(v.check).toBe(check);
      expect(v.detail).toContain(detail);
      expect(themis).toHaveLength(0);
    },
  );

  it("a refusal is also recognised when `capture_refused` is only in the text", async () => {
    const door = chaosDoor(
      refuse("invalid_input", "capture_refused: cycle guard: x"),
    );
    const out = await dialOn(door).admit([opCreate("Note", "n")], "notes");
    expect(out.admitted).toBe(false);
    expect((out.violations[0] as { check: string }).check).toBe(
      "depends_on_cycle",
    );
  });

  it("an expectation conflict stays a thrown ChaosClientError code conflict, not a violation", async () => {
    const door = chaosDoor(refuse("conflict", "slot held", 409));
    const err = await dialOn(door)
      .admit([opCreate("Note", "n")], "notes", [
        { s: NODE, predicate: "p", held: [] },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChaosClientError);
    expect((err as ChaosClientError).code).toBe("conflict");
    expect(door.seen).toHaveLength(1); // nothing retries
  });

  it("a transport failure throws (never admitted:false) and RetryingDial's pattern would match a refused dial", async () => {
    const door = chaosDoor(() => {
      throw new TypeError("connect ECONNREFUSED 10.0.0.1:8209");
    });
    const err = await dialOn(door)
      .admit([opCreate("Note", "n")], "notes")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(
      /dial tcp|server misbehaving|no such host|connection refused|ECONNREFUSED|EAI_AGAIN/i,
    );
  });

  it("a 503 with no star stamp (proxy/5xx) throws, never admitted:false", async () => {
    const door = chaosDoor(
      () => new Response("upstream down", { status: 503 }),
    );
    const res = await dialOn(door)
      .admit([opCreate("Note", "n")], "notes")
      .then(
        (v) => ({ v }),
        (e: unknown) => ({ e }),
      );
    expect(res).toHaveProperty("e");
  });

  it("a star-stamped 5xx fault throws and is not a violation", async () => {
    const door = chaosDoor(refuse("internal", "store exploded", 500));
    const res = await dialOn(door)
      .admit([opCreate("Note", "n")], "notes")
      .then(
        (v) => ({ v }),
        (e: unknown) => ({ e }),
      );
    expect(res).toHaveProperty("e");
  });
});

describe("isMissingSubject text (contract 4)", () => {
  it("an unknown subject keeps `no nodes row` and `s=<node>` reachable from chaos's own text", async () => {
    const text = `capture_refused: subject guard: no nodes row for s=${NODE}`;
    const door = chaosDoor(refuse("capture_refused", text));
    const res = await dialOn(door)
      .admit([opAdd(NODE, "p", { toLiteral: "x" })], "notes")
      .then(
        (v) => JSON.stringify(v),
        (e: unknown) => String(e),
      );
    expect(res).toContain("no nodes row");
    expect(res).toContain(`s=${NODE}`);
  });
});

describe("LocalChaosDial is unchanged (contract 5)", () => {
  it("still captures as author human, always admitted:true, with violations empty", async () => {
    const door = chaosDoor(
      ok({ tx: 4, results: [{ op: "createNode", id: NODE }] }),
    );
    // The sidecar dial builds its own ChaosRest; reach it by pointing fetch.
    globalThis.fetch = ((input: string, init?: RequestInit) =>
      Promise.resolve(
        new URL(input).pathname === "/openapi.json"
          ? new Response(CAPTURE_DOC, {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "X-Star": "chaos",
              },
            })
          : (() => {
              door.seen.push({
                method: init?.method ?? "GET",
                path: new URL(input).pathname,
                body: JSON.parse(
                  typeof init?.body === "string" ? init.body : "null",
                ) as Record<string, unknown> | null,
              });
              return new Response(
                JSON.stringify({
                  text: "",
                  structuredContent: {
                    tx: 4,
                    results: [{ op: "createNode", id: NODE }],
                  },
                }),
                {
                  status: 200,
                  headers: { "Content-Type": ENVELOPE, "X-Star": "chaos" },
                },
              );
            })(),
      )) as typeof fetch;
    const out = await new LocalChaosDial("http://chaos:8209").admit(
      [opCreate("Note", "n")],
      "notes",
    );
    expect(out).toEqual({
      admitted: true,
      minted: [NODE],
      violations: [],
      tx: 4,
    });
    expect(door.seen[0]?.path).toBe("/v1/capture");
    expect(door.seen[0]?.body?.author).toBe("human");
  });
});
