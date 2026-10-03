/**
 * LiveChaosDial's TLS decision, per dial: an https endpoint presents the
 * workload SVID pinned to the star that must answer, an http one is a plain
 * fetch. The Workload API is faked (no socket is opened) and fetch is stubbed
 * per test, so nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@forge/stellar-core-ts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    X509Source: { create: vi.fn(() => Promise.resolve({ fake: "svid" })) },
    authorizeStar: vi.fn((star: string) => `authorized:${star}`),
    tlsFetchOptions: vi.fn((_source: unknown, authorizer: unknown) => ({
      authorizer,
    })),
  };
});

const { LiveChaosDial } = await import("../src/chaos-client.js");

interface Seen {
  url: string;
  tls: unknown;
}

let seen: Seen[] = [];
const realFetch = globalThis.fetch;

function answer(result: unknown): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { structuredContent: result },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  seen = [];
  globalThis.fetch = ((input: string, init?: { tls?: unknown }) => {
    seen.push({ url: input, tls: init?.tls });
    return Promise.resolve(
      answer(input.includes("themis") ? { admitted: true, minted: [] } : []),
    );
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("LiveChaosDial — each dial's TLS is pinned to its own star", () => {
  it("an https themis admit presents the SVID authorized for themis", async () => {
    const dial = new LiveChaosDial({
      themisUrl: "https://themis:8201",
      chaosUrl: "http://chaos:8206",
    });
    await dial.admit([], "notes");
    expect(seen).toEqual([
      {
        url: "https://themis:8201/mcp",
        tls: { authorizer: "authorized:themis" },
      },
    ]);
  });

  it("an https chaos read presents the SVID authorized for chaos", async () => {
    const dial = new LiveChaosDial({
      themisUrl: "http://themis:8200",
      chaosUrl: "https://chaos:8207",
    });
    await dial.findByName("note", "x");
    expect(seen).toEqual([
      {
        url: "https://chaos:8207/mcp",
        tls: { authorizer: "authorized:chaos" },
      },
    ]);
  });

  it("an http dial is a plain fetch, no certificate", async () => {
    const dial = new LiveChaosDial({
      themisUrl: "http://themis:8200",
      chaosUrl: "http://chaos:8206",
    });
    await dial.admit([], "notes");
    await dial.findByName("note", "x");
    expect(seen).toEqual([
      { url: "http://themis:8200/mcp", tls: undefined },
      { url: "http://chaos:8206/mcp", tls: undefined },
    ]);
  });
});
