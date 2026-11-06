/**
 * LiveChaosDial's read shaping, pinned at the wire: what each reader does with
 * an empty input, a malformed reply and a well-formed one. The fetch is
 * injected; nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChaosClientError, LiveChaosDial } from "../src/chaos-client.js";

const realFetch = globalThis.fetch;
let calls: string[] = [];

function install(structured: unknown): void {
  calls = [];
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    calls.push(typeof init?.body === "string" ? init.body : "");
    void input;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { structuredContent: structured },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as unknown as typeof fetch;
}

const ENV_KEYS = [
  "CALLIOPE_THEMIS_URL",
  "CALLIOPE_CHAOS_URL",
  "CHAOS_URL",
  "CALLIOPE_CHAOS_REST_URL",
  "CALLIOPE_THEMIS_REST_URL",
];
const saved: Record<string, string> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) saved[k] = v;
    Reflect.deleteProperty(process.env, k);
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    Reflect.deleteProperty(process.env, k);
    const v = saved[k];
    if (v !== undefined) process.env[k] = v;
  }
});

const dial = (): LiveChaosDial =>
  new LiveChaosDial({
    themisUrl: "http://themis:8200",
    chaosUrl: "http://chaos:8206",
  });

describe("resolveScalars", () => {
  it("asks nothing for no hashes", async () => {
    install({ a: "1" });
    expect(await dial().resolveScalars([])).toStrictEqual({});
    expect(calls).toHaveLength(0);
  });

  it("answers each value as a string", async () => {
    install({ a: 1, b: true, c: "s", d: null, e: {} });
    expect(await dial().resolveScalars(["h"])).toStrictEqual({
      a: "1",
      b: "true",
      c: "s",
      d: "",
      e: "",
    });
  });

  it("answers empty to a null or non-object reply", async () => {
    install(null);
    expect(await dial().resolveScalars(["h"])).toStrictEqual({});
    install("abc");
    expect(await dial().resolveScalars(["h"])).toStrictEqual({});
  });
});

describe("node refs", () => {
  it("resolveNodeRefs keeps a ref only when it is a string and drops non-object rows", async () => {
    install({
      t1: { label: "L", kind: "K", ref: "r1" },
      t2: { label: "L2", kind: "K2" },
      t3: { label: "L3", kind: "K3", ref: 7 },
      t4: "nope",
    });
    expect(await dial().resolveNodeRefs(["t1"])).toStrictEqual({
      t1: { label: "L", kind: "K", ref: "r1" },
      t2: { label: "L2", kind: "K2" },
      t3: { label: "L3", kind: "K3" },
    });
  });

  it("resolveRefsEcho keeps the echoed ref as text, never undefined over it", async () => {
    install({
      refs: [{ label: "L", kind: "K" }, { ref: 7, label: "M", kind: "K" }],
      missing: [],
    });
    expect(await dial().resolveRefsEcho(["x"])).toStrictEqual({
      refs: [
        { ref: "", label: "L", kind: "K" },
        { ref: "7", label: "M", kind: "K" },
      ],
      missing: [],
    });
  });
});

describe("history", () => {
  it("shapes each transaction row", async () => {
    install({
      transactions: [
        { tx: 5, at: "2026-08-01T09:15:00Z", author: "a", note: "n" },
        { tx: "7", at: null, author: 3, note: null },
        { tx: 8, author: "b", note: "m" },
        null,
      ],
    });
    expect(await dial().history(["s"], ["f"])).toStrictEqual([
      { tx: 5, at: "2026-08-01T09:15:00Z", author: "a", note: "n" },
      { tx: 7, at: null, author: "3", note: "" },
      { tx: 8, at: null, author: "b", note: "m" },
      { tx: 0, at: null, author: "", note: "" },
    ]);
  });

  it("answers empty for a null reply, a missing list or a non-list", async () => {
    for (const reply of [null, {}, { transactions: "x" }]) {
      install(reply);
      expect(await dial().history(["s"], ["f"])).toStrictEqual([]);
    }
  });
});

describe("heldBlobs", () => {
  it("answers the held ids as text", async () => {
    install({ held: [1, "2"] });
    expect(await dial().heldBlobs()).toStrictEqual(["1", "2"]);
  });

  it("refuses a malformed report as bad_result", async () => {
    for (const reply of [null, {}, { held: "x" }]) {
      install(reply);
      const err = await dial()
        .heldBlobs()
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChaosClientError);
      expect(err).toMatchObject({
        message: "held_blobs: malformed report",
        code: "bad_result",
      });
    }
  });
});
