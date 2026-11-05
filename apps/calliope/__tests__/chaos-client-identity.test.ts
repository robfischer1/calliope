/**
 * LiveChaosDial holds one workload identity for the process's whole life: the
 * X509Source is created lazily, once, and every https call presents that same
 * source. The Workload API is faked; nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn((): Promise<unknown> => Promise.resolve({ fake: "svid" })),
  tlsFetchOptions: vi.fn((_source: unknown, authorizer: unknown) => ({
    authorizer,
  })),
}));

vi.mock("@forge/stellar-core-ts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    X509Source: { create: mocks.create },
    authorizeStar: vi.fn((star: string) => `authorized:${star}`),
    tlsFetchOptions: mocks.tlsFetchOptions,
  };
});

const { LiveChaosDial } = await import("../src/chaos-client.js");

const realFetch = globalThis.fetch;

beforeEach(() => {
  mocks.create.mockClear();
  mocks.tlsFetchOptions.mockClear();
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { structuredContent: [] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("LiveChaosDial — the SVID source is held, not re-fetched", () => {
  it("creates one source for many https calls and presents it each time", async () => {
    const dial = new LiveChaosDial({
      themisUrl: "https://themis:8201",
      chaosUrl: "https://chaos:8207",
    });
    await dial.findByName("note", "a");
    await dial.findByName("note", "b");
    await dial.resolveNodes(["t"]);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const sources = mocks.tlsFetchOptions.mock.calls.map(([source]) => source);
    expect(sources).toStrictEqual([
      { fake: "svid" },
      { fake: "svid" },
      { fake: "svid" },
    ]);
  });

  it("an http-only dial never opens the Workload API", async () => {
    const dial = new LiveChaosDial({
      themisUrl: "http://themis:8200",
      chaosUrl: "http://chaos:8206",
    });
    await dial.findByName("note", "a");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
