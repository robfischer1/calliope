// Test-only: a Kairos stand-in (an ES256 key, its JWKS, an assertion minter).
import { generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { ActConfig, FetchLike } from "../src/act-assertion.js";

export const TD = "notusmi.com";
export const ISS = "https://kairos.notusmi.com";
export const KID = "k1";

export const CONFIG: ActConfig = {
  jwksUrl: "http://kairos/jwks",
  issuer: ISS,
  trustDomain: TD,
};

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });

export const okFetch: FetchLike = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    text: () =>
      Promise.resolve(
        JSON.stringify({
          keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: KID }],
        }),
      ),
  });

export const b64 = (o: unknown): string =>
  Buffer.from(JSON.stringify(o)).toString("base64url");

export interface MintOpts {
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  key?: KeyObject;
  now?: number;
}

/** An assertion for `args` (a sha256 hex), signed like Kairos signs one. */
export function mint(args: string, o: MintOpts = {}): string {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", typ: "act+jwt", kid: KID, ...o.header };
  const claims = {
    iss: ISS,
    sub: `spiffe://${TD}/human/robfischer1`,
    aud: "calliope",
    azp: `spiffe://${TD}/star/charon`,
    amr: ["passkey"],
    act: "calliope_write",
    args_sha256: args,
    jti: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
      "hex",
    ),
    iat: now,
    nbf: now,
    exp: now + 120,
    ...o.claims,
  };
  const data = `${b64(header)}.${b64(claims)}`;
  const sig = sign("sha256", Buffer.from(data), {
    key: o.key ?? pair.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${data}.${sig.toString("base64url")}`;
}
