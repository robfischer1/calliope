import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Peer } from "@forge/stellar-core-ts";
import {
  ActRefusal,
  JwksCache,
  MemoryJtiStore,
  actConfigFromEnv,
  verifyActAssertion,
} from "../src/act-assertion.js";
import type { ActConfig, FetchLike } from "../src/act-assertion.js";
import {
  CHARON,
  CONFIG,
  ISS,
  KID,
  TD,
  b64,
  mint,
  okFetch,
} from "./act-fixtures.js";
import type { MintOpts } from "./act-fixtures.js";

const DIGEST = "a".repeat(64);
const nowS = (): number => Math.floor(Date.now() / 1000);

interface Over {
  peer?: Peer | undefined;
  config?: ActConfig;
  fetch?: FetchLike;
  jti?: MemoryJtiStore;
  digest?: string;
}

function run(token: string, over: Over = {}): Promise<unknown> {
  const config = over.config ?? CONFIG;
  return verifyActAssertion({
    token,
    argsSha256: over.digest ?? DIGEST,
    verb: "/v1/write_container",
    peer: "peer" in over ? over.peer : CHARON,
    config,
    keys:
      config.jwksUrl === ""
        ? undefined
        : new JwksCache(config.jwksUrl, over.fetch ?? okFetch),
    jti: over.jti ?? new MemoryJtiStore(),
  });
}

const refused = async (p: Promise<unknown>): Promise<ActRefusal> => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ActRefusal);
  return e as ActRefusal;
};

describe("verifyActAssertion", () => {
  it("accepts a valid assertion and names human/<handle> via star/charon", async () => {
    expect(await run(mint(DIGEST))).toMatchObject({
      authoredBy: "human/robfischer1",
      via: "star/charon",
      verb: "write_container",
    });
  });

  const cases: [string, MintOpts][] = [
    ["alg none", { header: { alg: "none" } }],
    ["alg HS256", { header: { alg: "HS256" } }],
    ["wrong typ", { header: { typ: "JWT" } }],
    ["no typ", { header: { typ: undefined } }],
    ["crit header", { header: { crit: ["x"] } }],
    ["wrong aud", { claims: { aud: "hades" } }],
    ["aud array", { claims: { aud: ["calliope"] } }],
    ["wrong azp", { claims: { azp: `spiffe://${TD}/star/nomos` } }],
    ["azp other domain", { claims: { azp: "spiffe://evil.test/star/charon" } }],
    ["wrong act", { claims: { act: "inscribe" } }],
    ["wrong iss", { claims: { iss: "https://evil.test" } }],
    ["missing amr", { claims: { amr: undefined } }],
    ["amr without passkey", { claims: { amr: ["pwd"] } }],
    ["sub other domain", { claims: { sub: "spiffe://evil.test/human/rob" } }],
    ["sub not human", { claims: { sub: `spiffe://${TD}/star/charon` } }],
    ["sub bad handle", { claims: { sub: `spiffe://${TD}/human/Rob%2f..` } }],
    ["sub nested", { claims: { sub: `spiffe://${TD}/human/a/b` } }],
    ["expired", { now: nowS() - 600 }],
    ["not yet valid", { claims: { nbf: nowS() + 60 } }],
    ["lifetime too long", { claims: { exp: nowS() + 3600 } }],
    ["bad jti", { claims: { jti: "x" } }],
    ["unknown kid", { header: { kid: "nope" } }],
    [
      "forged signature (other key)",
      { key: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey },
    ],
  ];
  it.each(cases)("refuses %s", async (_n, o) => {
    const e = await refused(run(mint(DIGEST, o)));
    expect(e.status).toBe(401);
  });

  it("refuses args changed after minting", async () => {
    const e = await refused(run(mint(DIGEST), { digest: "b".repeat(64) }));
    expect(e.code).toBe("act_assertion_invalid");
  });

  it("refuses a tampered payload", async () => {
    const [h, , s] = mint(DIGEST).split(".");
    const forged = b64({
      iss: ISS,
      sub: `spiffe://${TD}/human/evil`,
      aud: "calliope",
      azp: `spiffe://${TD}/star/charon`,
      amr: ["passkey"],
      act: "calliope_write",
      args_sha256: DIGEST,
      jti: "0".repeat(32),
      iat: nowS(),
      nbf: nowS(),
      exp: nowS() + 100,
    });
    await refused(run(`${h ?? ""}.${forged}.${s ?? ""}`));
  });

  it("refuses malformed tokens", async () => {
    for (const t of ["", "a.b", "a.b.c.d", "!!.@@.##", mint(DIGEST) + "A"]) {
      await refused(run(t));
    }
  });

  it("refuses a replayed jti, once", async () => {
    const jti = new MemoryJtiStore();
    const t = mint(DIGEST);
    await run(t, { jti });
    const e = await refused(run(t, { jti }));
    expect(e.code).toBe("act_assertion_replayed");
  });

  it("does not spend the jti on a request that fails another check", async () => {
    const jti = new MemoryJtiStore();
    const t = mint(DIGEST);
    await refused(run(t, { jti, digest: "b".repeat(64) }));
    await run(t, { jti });
  });

  it("refuses any peer but charon, with a good token", async () => {
    const nomos: Peer = {
      ...CHARON,
      spiffeId: `spiffe://${TD}/star/nomos`,
      name: "nomos",
    };
    const peers: (Peer | undefined)[] = [
      undefined,
      nomos,
      { ...CHARON, attest: "network" },
      { ...CHARON, spiffeId: "spiffe://evil.test/star/charon" },
    ];
    for (const peer of peers) {
      const e = await refused(run(mint(DIGEST), { peer }));
      expect(e.status).toBe(403);
    }
  });

  it("fails closed when the JWKS is unreachable and nothing is cached", async () => {
    const down: FetchLike = () => Promise.reject(new Error("econnrefused"));
    const e = await refused(run(mint(DIGEST), { fetch: down }));
    expect(e.status).toBe(503);
    expect(e.code).toBe("act_assertion_unavailable");
  });

  it("defaults issuer and trust domain to Kairos's own; the JWKS URL has none", () => {
    expect(actConfigFromEnv({})).toEqual({
      jwksUrl: "",
      issuer: ISS,
      trustDomain: TD,
    });
    expect(
      actConfigFromEnv({
        STELLAR_KAIROS_JWKS_URL: "http://kairos:9211/jwks",
        CALLIOPE_ACT_ISSUER: "https://other",
      }),
    ).toEqual({
      jwksUrl: "http://kairos:9211/jwks",
      issuer: "https://other",
      trustDomain: TD,
    });
  });

  it("refuses when config is unset", async () => {
    for (const config of [
      { ...CONFIG, jwksUrl: "" },
      { ...CONFIG, issuer: "" },
      { ...CONFIG, trustDomain: "" },
    ]) {
      const e = await refused(run(mint(DIGEST), { config }));
      expect(e.status).toBe(503);
    }
  });

  it("keeps cached keys when a refresh fails, and rate-limits refetches", async () => {
    let calls = 0;
    let fail = false;
    let t = 1_000_000;
    const f: FetchLike = (u, init) => {
      calls += 1;
      return fail ? Promise.reject(new Error("down")) : okFetch(u, init);
    };
    const cache = new JwksCache("u", f, () => t);
    expect(await cache.keyFor(KID)).toBeDefined();
    fail = true;
    t += 400_000; // stale: the refetch fails, the key is held
    expect(await cache.keyFor(KID)).toBeDefined();
    const before = calls;
    for (let i = 0; i < 5; i++) {
      expect(await cache.keyFor("forged")).toBeUndefined();
    }
    expect(calls - before).toBeLessThanOrEqual(1);
  });
});
