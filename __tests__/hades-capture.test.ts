import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CharonError,
  HadesCapture,
  hadesEnabled,
  charonUrl,
} from "../src/mcp/hades-capture.js";
import { HAS_PART, ORDER_KEY, TEXT } from "../src/urania-client.js";
import type { CharonBodyRequest } from "../src/mcp/hades-capture.js";

/** Read body bytes from a RequestInit as a string. */
function bodyText(init: RequestInit | undefined): string {
  const b = init?.body;
  return typeof b === "string" ? b : "";
}

interface CapturedPost {
  url: string;
  req: CharonBodyRequest;
}

/** Stub fetch returning the given response shape for all POSTs. */
function stubFetch(
  responseFactory: (req: CharonBodyRequest) => object,
): { calls: CapturedPost[]; restore: () => void } {
  const calls: CapturedPost[] = [];
  const original = globalThis.fetch;
  const fake: typeof fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const req = JSON.parse(bodyText(init)) as CharonBodyRequest;
    calls.push({ url, req });
    const response: Pick<Response, "ok" | "json"> = {
      ok: true,
      json: () => Promise.resolve(responseFactory(req)),
    };
    return Promise.resolve(response as Response);
  };
  globalThis.fetch = vi.fn(fake);
  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe("hadesEnabled / charonUrl", () => {
  it("hadesEnabled returns false when CALLIOPE_WRITE_VIA_HADES is unset", () => {
    expect(hadesEnabled({})).toBe(false);
  });

  it("hadesEnabled returns true for '1'", () => {
    expect(hadesEnabled({ CALLIOPE_WRITE_VIA_HADES: "1" })).toBe(true);
  });

  it("hadesEnabled returns true for 'true'", () => {
    expect(hadesEnabled({ CALLIOPE_WRITE_VIA_HADES: "true" })).toBe(true);
  });

  it("charonUrl uses CHARON_URL from env", () => {
    expect(charonUrl({ CHARON_URL: "http://myhost:9000" })).toBe(
      "http://myhost:9000",
    );
  });

  it("charonUrl falls back to default when CHARON_URL is absent", () => {
    expect(charonUrl({})).toBe("http://charon:8300");
  });
});

describe("HadesCapture — write_body shape and provenance", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch(() => ({ ok: true }));
  });
  afterEach(() => {
    stub.restore();
  });

  it("POSTs to CHARON_URL/api/body with verb=write_body", async () => {
    const cap = new HadesCapture("http://charon:8300");
    await cap.capture([
      { op: "addEdge", from: "note-id", predicate: HAS_PART, to: "sec-id" },
      { op: "addEdge", from: "sec-id", predicate: TEXT, to: "Hello" },
    ]);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe("http://charon:8300/api/body");
    expect(stub.calls[0]?.req.verb).toBe("write_body");
  });

  it("includes authored_by='human' by default (gateway auth seam)", async () => {
    const cap = new HadesCapture("http://charon:8300");
    await cap.capture([
      { op: "addEdge", from: "note-id", predicate: HAS_PART, to: "sec-id" },
      { op: "addEdge", from: "sec-id", predicate: TEXT, to: "Hello" },
    ]);
    expect(stub.calls[0]?.req.authored_by).toBe("human");
  });

  it("passes authored_by='calliope' when specified", async () => {
    const cap = new HadesCapture("http://charon:8300");
    await cap.capture(
      [
        { op: "addEdge", from: "note-id", predicate: HAS_PART, to: "sec-id" },
        { op: "addEdge", from: "sec-id", predicate: TEXT, to: "Hello" },
      ],
      "calliope",
    );
    expect(stub.calls[0]?.req.authored_by).toBe("calliope");
  });

  it("extracts section texts from addEdge text ops", async () => {
    const cap = new HadesCapture("http://charon:8300");
    await cap.capture([
      { op: "addEdge", from: "note", predicate: HAS_PART, to: "s1" },
      { op: "addEdge", from: "s1", predicate: TEXT, to: "First" },
      { op: "addEdge", from: "note", predicate: HAS_PART, to: "s2" },
      { op: "addEdge", from: "s2", predicate: TEXT, to: "Second" },
    ]);
    expect(stub.calls[0]?.req.sections).toEqual([
      { text: "First" },
      { text: "Second" },
    ]);
  });

  it("sets node_id from the first hasPart addEdge", async () => {
    const cap = new HadesCapture("http://charon:8300");
    await cap.capture([
      { op: "addEdge", from: "note-abc", predicate: HAS_PART, to: "s1" },
      { op: "addEdge", from: "s1", predicate: TEXT, to: "Hello" },
    ]);
    expect(stub.calls[0]?.req.node_id).toBe("note-abc");
  });

  it("skips the POST when ops have no text addEdges (removeEdge-only batch)", async () => {
    const cap = new HadesCapture("http://charon:8300");
    await cap.capture([
      { op: "removeEdge", from: "note", predicate: HAS_PART, to: "s1" },
    ]);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("HadesCapture — read_body / resolve", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs verb=read_body and expands sections to UraniaTriples", async () => {
    const s0 = "sec0";
    const s1 = "sec1";
    const note = "note-xyz";
    const calls: CapturedPost[] = [];
    const original = globalThis.fetch;
    const fakeFn: typeof fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const req = JSON.parse(bodyText(init)) as CharonBodyRequest;
      calls.push({ url, req });
      const response: Pick<Response, "ok" | "json"> = {
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            sections: [
              { id: s0, text: "First", orderKey: "N" },
              { id: s1, text: "Second", orderKey: "N:" },
            ],
          }),
      };
      return Promise.resolve(response as Response);
    };
    globalThis.fetch = vi.fn(fakeFn);

    const cap = new HadesCapture("http://charon:8300");
    const triples = await cap.resolve(note);

    expect(calls[0]?.req.verb).toBe("read_body");
    expect(calls[0]?.req.node_id).toBe(note);

    // hasPart edges
    expect(triples).toContainEqual({ from: note, predicate: HAS_PART, to: s0 });
    expect(triples).toContainEqual({ from: note, predicate: HAS_PART, to: s1 });
    // text literals
    expect(triples).toContainEqual({ from: s0, predicate: TEXT, to: "First" });
    expect(triples).toContainEqual({ from: s1, predicate: TEXT, to: "Second" });
    // order_key literals
    expect(triples).toContainEqual({ from: s0, predicate: ORDER_KEY, to: "N" });
    expect(triples).toContainEqual({ from: s1, predicate: ORDER_KEY, to: "N:" });
    expect(triples).toHaveLength(6); // 2 hasPart + 2 text + 2 order_key

    globalThis.fetch = original;
  });
});

describe("HadesCapture — error handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws CharonError on non-ok HTTP response", async () => {
    const original = globalThis.fetch;
    const fakeNonOk: typeof fetch = () =>
      Promise.resolve({
        ok: false,
        status: 503,
        text: () => Promise.resolve("service unavailable"),
        json: () => Promise.resolve({}),
      } as Response);
    globalThis.fetch = vi.fn(fakeNonOk);

    const cap = new HadesCapture("http://charon:8300");
    await expect(
      cap.capture([
        { op: "addEdge", from: "n", predicate: HAS_PART, to: "s" },
        { op: "addEdge", from: "s", predicate: TEXT, to: "x" },
      ]),
    ).rejects.toBeInstanceOf(CharonError);

    globalThis.fetch = original;
  });

  it("throws CharonError when response.ok=false in the JSON body", async () => {
    const original = globalThis.fetch;
    const fakeErrBody: typeof fetch = () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: false, error: "node not found" }),
      } as Response);
    globalThis.fetch = vi.fn(fakeErrBody);

    const cap = new HadesCapture("http://charon:8300");
    await expect(
      cap.capture([
        { op: "addEdge", from: "n", predicate: HAS_PART, to: "s" },
        { op: "addEdge", from: "s", predicate: TEXT, to: "x" },
      ]),
    ).rejects.toThrow(/node not found/);

    globalThis.fetch = original;
  });
});

describe("HadesCapture — mintSectionId", () => {
  it("yields a 64-hex urania node id", () => {
    const cap = new HadesCapture("http://charon:8300");
    const id = cap.mintSectionId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(cap.mintSectionId()).not.toBe(id);
  });
});
