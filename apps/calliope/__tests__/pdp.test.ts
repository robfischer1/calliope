import { describe, expect, it } from "vitest";
import {
  Ouranos,
  actionOf,
  consultBody,
  consulted,
  deriveEndpointDecisionUrl,
  deriveManifestUrl,
  deriveStandingUrl,
  pdpFromEnv,
} from "../src/mcp/pep/pdp.js";
import type { Query } from "../src/mcp/pep/pdp.js";

/** The PDP client, against stellar-core-go `policy/ouranos_test.go` and
 *  `consult_test.go`: the wire shape, the answer mapping, the fault posture,
 *  the timeout, the cache and the epoch. */

const DECISION = "http://ouranos-opa:8181/v1/data/authz/decision";
const ENDPOINT = "http://ouranos-opa:8181/v1/data/authz/endpoint_decision";
const Q: Query = {
  principal: "spiffe://notusmi.com/session/abc",
  principalType: "session",
  verb: "read_container",
  star: "calliope",
  action: "",
};

interface Seen {
  url: string;
  method: string;
  body: unknown;
  contentType: string | null;
}

/** A fetch that answers `reply` per URL and records what it was asked. */
function fakeFetch(
  reply: (url: string, n: number) => Response | Promise<Response>,
): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = ((url: string, init?: RequestInit) => {
    seen.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      contentType: new Headers(init?.headers).get("content-type"),
    });
    return Promise.resolve(reply(url, seen.length));
  }) as typeof fetch;
  return { fetch: f, seen };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const allow = (): Response => json({ result: { allow: true, reasons: [] } });

const quiet = (): void => undefined;

describe("request shape", () => {
  it("posts {input:{principal:{type,subject},verb,star}} to endpoint_decision", async () => {
    const { fetch, seen } = fakeFetch(allow);
    await new Ouranos({ url: ENDPOINT, fetch, log: quiet }).decide(Q);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      url: ENDPOINT,
      method: "POST",
      contentType: "application/json",
      body: {
        input: {
          principal: { type: "session", subject: Q.principal },
          verb: "read_container",
          star: "calliope",
        },
      },
    });
  });

  it("carries args:{action} only when the action is known", () => {
    expect(JSON.parse(consultBody({ ...Q, action: "" }))).not.toHaveProperty(
      "input.args",
    );
    expect(JSON.parse(consultBody({ ...Q, action: "delete" }))).toHaveProperty(
      "input.args",
      { action: "delete" },
    );
  });

  it("actionOf reads only a string action of an object", () => {
    expect(actionOf({ action: "write", payload: "secret" })).toBe("write");
    expect(actionOf({ action: 3 })).toBe("");
    expect(actionOf({})).toBe("");
    expect(actionOf(undefined)).toBe("");
    expect(actionOf("action")).toBe("");
    expect(actionOf(null)).toBe("");
  });

  it("derives the sibling documents from the decision URL, and nothing from another", () => {
    expect(deriveEndpointDecisionUrl(DECISION)).toBe(ENDPOINT);
    expect(deriveStandingUrl(DECISION)).toBe(
      "http://ouranos-opa:8181/v1/data/die_standing",
    );
    expect(deriveManifestUrl(DECISION)).toBe(
      "http://ouranos-opa:8181/v1/data/system/bundles/policy/manifest",
    );
    expect(deriveEndpointDecisionUrl("http://x/other")).toBe("");
  });

  it("pdpFromEnv: unset = no PDP; a URL that derives nothing = no PDP, said once", () => {
    const lines: string[] = [];
    expect(pdpFromEnv({}, (l) => lines.push(l))).toBeUndefined();
    expect(
      pdpFromEnv({ STELLAR_PDP_URL: "http://x/other" }, (l) => lines.push(l)),
    ).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/STELLAR_PDP_URL does not end in/);
    expect(pdpFromEnv({ STELLAR_PDP_URL: DECISION }, quiet)).toBeInstanceOf(
      Ouranos,
    );
  });
});

describe("answer mapping", () => {
  it("allow -> pdp_allows (allow)", async () => {
    const { fetch } = fakeFetch(allow);
    const a = await new Ouranos({ url: ENDPOINT, fetch, log: quiet }).decide(Q);
    expect(a.error).toBeUndefined();
    const d = consulted(
      {
        verdict: "consult",
        reason: "pdp_not_consulted",
        contract: "",
        principal: Q.principal,
        principalType: "session",
      },
      a,
    );
    expect([d.verdict, d.reason, d.principal]).toEqual([
      "allow",
      "pdp_allows",
      Q.principal,
    ]);
  });

  it("deny -> pdp_denies (deny), carrying the plane's first reason", async () => {
    const { fetch } = fakeFetch(() =>
      json({ result: { allow: false, reasons: ["no grant", "other"] } }),
    );
    const a = await new Ouranos({ url: ENDPOINT, fetch, log: quiet }).decide(Q);
    expect(a.error).toBeUndefined();
    expect(a.verdict).toEqual({ allow: false, reason: "no grant" });
    const d = consulted(
      {
        verdict: "consult",
        reason: "pdp_not_consulted",
        contract: "",
        principal: Q.principal,
        principalType: "session",
      },
      a,
    );
    expect([d.verdict, d.reason]).toEqual(["deny", "pdp_denies"]);
  });

  it("a deny with no reasons carries 'denied by policy'", async () => {
    const { fetch } = fakeFetch(() => json({ result: { allow: false } }));
    const a = await new Ouranos({ url: ENDPOINT, fetch, log: quiet }).decide(Q);
    expect(a.verdict.reason).toBe("denied by policy");
  });

  it.each([
    ["a transport fault", () => Promise.reject(new Error("ECONNREFUSED"))],
    ["a non-200", () => json({}, 503)],
    ["an undecodable body", () => new Response("not json", { status: 200 })],
  ])("%s -> pdp_error, allow under fail-open", async (_n, reply) => {
    const lines: string[] = [];
    const f = (() => reply()) as unknown as typeof fetch;
    const a = await new Ouranos({
      url: ENDPOINT,
      fetch: f,
      log: (l) => lines.push(l),
    }).decide(Q);
    expect(a.error).toBeInstanceOf(Error);
    expect(a.verdict.allow).toBe(true);
    expect(lines.join("\n")).toMatch(/PERMITTING \(fail-open\)/);
    const d = consulted(
      {
        verdict: "consult",
        reason: "pdp_not_consulted",
        contract: "",
        principal: Q.principal,
        principalType: "session",
      },
      a,
    );
    expect([d.verdict, d.reason]).toEqual(["allow", "pdp_error"]);
  });

  it("fail-closed posture: a fault denies, still as an error", async () => {
    const { fetch } = fakeFetch(() => json({}, 500));
    const a = await new Ouranos({
      url: ENDPOINT,
      fetch,
      failOpen: false,
      log: quiet,
    }).decide(Q);
    expect(a.error).toBeDefined();
    expect(a.verdict).toEqual({
      allow: false,
      reason: "policy decision unavailable",
    });
  });

  it("identity gates decide locally, never on the wire", async () => {
    const { fetch, seen } = fakeFetch(allow);
    const o = new Ouranos({ url: ENDPOINT, fetch, log: quiet });
    expect((await o.decide({ ...Q, principal: "" })).verdict.reason).toBe(
      "unidentifiable caller",
    );
    expect(
      (await o.decide({ ...Q, principalType: "agent" })).verdict.reason,
    ).toBe("caller not permitted (unmapped subject)");
    expect(seen).toHaveLength(0);
  });
});

describe("timeout", () => {
  it("a plane that never answers is cut at timeoutMs and recorded as a fault", async () => {
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          rej(new DOMException("timed out", "TimeoutError"));
        });
      })) as unknown as typeof fetch;
    const t0 = Date.now();
    const a = await new Ouranos({
      url: ENDPOINT,
      fetch: hang,
      timeoutMs: 30,
      log: quiet,
    }).decide(Q);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(a.error?.message).toMatch(/authz consult/);
    expect(a.verdict.allow).toBe(true);
  });
});

describe("cache and epoch", () => {
  it("serves a repeat from the cache until the TTL, and never caches a fault", async () => {
    let t = 0;
    let fail = true;
    const { fetch, seen } = fakeFetch(() => (fail ? json({}, 500) : allow()));
    const o = new Ouranos({
      url: ENDPOINT,
      fetch,
      ttlMs: 1_000,
      now: () => t,
      log: quiet,
    });
    await o.decide(Q); // fault, not cached
    fail = false;
    await o.decide(Q); // asks again, caches
    await o.decide(Q); // cache
    expect(seen).toHaveLength(2);
    t = 1_001;
    await o.decide(Q); // expired
    expect(seen).toHaveLength(3);
    await o.decide({ ...Q, verb: "other" }); // a different key
    expect(seen).toHaveLength(4);
  });

  it("a changed policy epoch invalidates the cache; a failed read keeps the last epoch", async () => {
    let t = 0;
    let revision = "r1";
    let manifestUp = true;
    const { fetch, seen } = fakeFetch((url) => {
      if (url.endsWith("/manifest")) {
        return manifestUp ? json({ result: { revision } }) : json({}, 500);
      }
      if (url.endsWith("/die_standing")) return json({}, 500);
      return allow();
    });
    const o = new Ouranos({
      url: ENDPOINT,
      manifestUrl: "http://p/v1/data/system/bundles/policy/manifest".replace(
        "manifest",
        "manifest",
      ),
      standingUrl: "http://p/v1/data/die_standing",
      ttlMs: 10_000,
      standingIntervalMs: 100,
      fetch,
      now: () => t,
      log: quiet,
    });
    const consults = (): number =>
      seen.filter((s) => s.method === "POST").length;
    await o.decide(Q);
    await o.decide(Q);
    expect(consults()).toBe(1);
    t = 200;
    revision = "r2";
    await o.decide(Q); // epoch moved: consult again
    expect(consults()).toBe(2);
    t = 400;
    manifestUp = false; // both epoch sources fail: keep r2, so the cache holds
    await o.decide(Q);
    expect(consults()).toBe(2);
  });
});
