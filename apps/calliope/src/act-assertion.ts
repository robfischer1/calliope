/**
 * The act assertion: who a note write is FOR, when the writer is charon.
 *
 * Theia's note edits go Theia -> charon -> calliope, and charon calls calliope
 * as itself (charon-sa). That proves "charon asked", not who. Charon therefore
 * carries, beside the call, a short-lived Kairos act assertion (ES256, typ
 * `act+jwt`) naming the person whose passkey session approved it, in the
 * `x-charon-act-assertion` header. This module is the verifier: the reference
 * issuer is kairos `internal/issue/act.go` (ParseActAssertion), the minting side
 * charon `lib/act-assertion.ts`.
 *
 * WHAT MAKES A NAME TRUSTWORTHY HERE (all of it, or nothing is honoured):
 *  1. the signature verifies under a key in Kairos's JWKS (alg exactly ES256,
 *     typ exactly `act+jwt`, no `crit`), issuer, audience `calliope`, azp
 *     `star/charon` in the configured trust domain, act `calliope_write`,
 *     passkey in amr, a short validity window;
 *  2. args_sha256 equals the digest of the arguments ACTUALLY RECEIVED, so an
 *     assertion cannot be lent to other arguments;
 *  3. the jti is spent exactly once ({@link JtiStore}); Kairos does not track it.
 *
 * Absent header: today's behaviour, unattributed. Present but unacceptable:
 * refused, whoever sent it.
 *
 * Config is the environment, and a PRESENT assertion with any of it unset is
 * refused (fail closed); requests without the header never read it.
 */

import { createPublicKey, timingSafeEqual, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/** The request header charon sends the assertion in. */
export const ACT_ASSERTION_HEADER = "x-charon-act-assertion";
/** The JWS `typ`. */
export const ACT_TYP = "act+jwt";
/** The one act this star verifies. */
export const ACT_CALLIOPE_WRITE = "calliope_write";
/** This star, as the assertion's audience. */
export const ACT_AUDIENCE = "calliope";
/** The one authentication method recorded. */
export const AMR_PASSKEY = "passkey";
/** What every attributed revision records as its `via`. */
export const VIA_CHARON = "star/charon";
/** Clock skew tolerated at either edge of the validity window. */
export const LEEWAY_S = 5;
/** The longest an assertion may live (kairos `Acts` TTL for calliope_write). */
export const MAX_LIFETIME_S = 120;

/**
 * The REST paths an assertion may ride: the six body-write verbs, plus
 * delete_note's live face. The adapter spells dry_run:false as the `/live` path
 * suffix (stellar-core rest/table.ts DANGEROUS); calliope's other verbs have no
 * dry_run, force or confirm, so they have no suffixed path.
 */
export const WRITE_VERB_PATHS: ReadonlySet<string> = new Set([
  "/v1/write_container",
  "/v1/create_note",
  "/v1/set_properties",
  "/v1/delete_note",
  "/v1/delete_note/live",
  "/v1/restore_note",
  "/v1/move_blocks",
]);

/** Why an assertion was not honoured: the HTTP status and a stable code. */
export class ActRefusal extends Error {
  override readonly name = "ActRefusal";
  constructor(
    readonly status: 401 | 403 | 413 | 503,
    readonly code:
      | "act_assertion_invalid"
      | "act_assertion_forbidden"
      | "act_assertion_replayed"
      | "act_assertion_unavailable",
    detail: string,
  ) {
    super(detail);
  }
}

const invalid = (why: string): ActRefusal =>
  new ActRefusal(401, "act_assertion_invalid", why);

// ── config ──────────────────────────────────────────────────────────────────

/** What the verifier needs; any field empty means a present assertion is refused. */
export interface ActConfig {
  /** Kairos's `/jwks` URL. */
  readonly jwksUrl: string;
  /** Kairos's session issuer (`iss`), e.g. https://kairos.notusmi.com. */
  readonly issuer: string;
  /** The SPIFFE trust domain `sub` and `azp` must live in. */
  readonly trustDomain: string;
}

/**
 * Kairos's session issuer and trust domain as Kairos issues them: the defaults
 * of `KAIROS_SESSION_ISSUER` / `KAIROS_SESSION_TRUST_DOMAIN` in
 * kairos `internal/config/config.go`, which no flux manifest overrides. They
 * name WHAT to expect, never what to trust: a token still has to verify under
 * Kairos's JWKS.
 */
export const DEFAULT_ISSUER = "https://kairos.notusmi.com";
export const DEFAULT_TRUST_DOMAIN = "notusmi.com";

/**
 * The config from the environment. `CALLIOPE_ACT_JWKS_URL` falls back to
 * `STELLAR_KAIROS_JWKS_URL` (the same Kairos the PEP already reads) and has no
 * default: unset, a present assertion is refused. Issuer and trust domain
 * default to Kairos's own ({@link DEFAULT_ISSUER}) and env overrides.
 */
export function actConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ActConfig {
  const pick = (...names: string[]): string => {
    for (const n of names) {
      const v = (env[n] ?? "").trim();
      if (v !== "") return v;
    }
    return "";
  };
  return {
    jwksUrl: pick("CALLIOPE_ACT_JWKS_URL", "STELLAR_KAIROS_JWKS_URL"),
    issuer: pick("CALLIOPE_ACT_ISSUER") || DEFAULT_ISSUER,
    trustDomain: pick("CALLIOPE_ACT_TRUST_DOMAIN") || DEFAULT_TRUST_DOMAIN,
  };
}

// ── the JWKS ────────────────────────────────────────────────────────────────

/** The slice of `fetch` the key cache uses. */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

const JWKS_FETCH_TIMEOUT_MS = 5_000;
const JWKS_MAX_BYTES = 1 << 20;
/** A refetch for an unknown kid happens at most this often, whatever asks. */
export const JWKS_REFRESH_MIN_MS = 10_000;
/** A held key set older than this is refetched on next use. */
const JWKS_TTL_MS = 300_000;

function p256Key(jwk: unknown): KeyObject | undefined {
  if (typeof jwk !== "object" || jwk === null || Array.isArray(jwk)) {
    return undefined;
  }
  const k = jwk as Record<string, unknown>;
  if (k.kty !== "EC" || k.crv !== "P-256") return undefined;
  if (typeof k.x !== "string" || typeof k.y !== "string") return undefined;
  try {
    return createPublicKey({
      key: { kty: "EC", crv: "P-256", x: k.x, y: k.y },
      format: "jwk",
    });
  } catch {
    return undefined;
  }
}

/**
 * Kairos's key set, cached. A key is looked up by `kid`; an unknown kid (or a
 * stale set) triggers ONE refetch, and no more than one per
 * {@link JWKS_REFRESH_MIN_MS} whatever asks, so a stream of forged kids cannot
 * turn into a stream of requests. A failed fetch keeps the set held; with
 * nothing held and the fetch failing, there is no key and the caller refuses.
 */
export class JwksCache {
  #keys = new Map<string, KeyObject>();
  #fetchedAt = Number.NEGATIVE_INFINITY;
  #attemptedAt = Number.NEGATIVE_INFINITY;
  #inflight: Promise<void> | undefined;
  #failed = false;
  readonly #fetch: FetchLike;

  constructor(
    readonly url: string,
    fetchImpl?: FetchLike,
    private readonly nowMs: () => number = Date.now,
  ) {
    this.#fetch = fetchImpl ?? globalThis.fetch;
  }

  /** True when no key is held and the last fetch failed: Kairos is unreachable. */
  get down(): boolean {
    return this.#keys.size === 0 && this.#failed;
  }

  async keyFor(kid: string): Promise<KeyObject | undefined> {
    if (kid === "") return undefined;
    const now = this.nowMs();
    const known = this.#keys.has(kid);
    const stale = now - this.#fetchedAt > JWKS_TTL_MS;
    const due = now - this.#attemptedAt >= JWKS_REFRESH_MIN_MS;
    if ((!known || stale) && due) {
      this.#inflight ??= this.#refresh(now).finally(() => {
        this.#inflight = undefined;
      });
    }
    if (this.#inflight !== undefined) await this.#inflight;
    return this.#keys.get(kid);
  }

  async #refresh(now: number): Promise<void> {
    this.#attemptedAt = now;
    try {
      this.#keys = await this.#read();
      this.#fetchedAt = now;
      this.#failed = false;
    } catch (err) {
      this.#failed = true;
      process.stderr.write(
        `calliope-act: the Kairos JWKS could not be read url=${this.url} held=${String(this.#keys.size)} err=${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  async #read(): Promise<Map<string, KeyObject>> {
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      ctl.abort();
    }, JWKS_FETCH_TIMEOUT_MS);
    timer.unref();
    let body: string;
    try {
      const resp = await this.#fetch(this.url, { signal: ctl.signal });
      if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}`);
      body = await resp.text();
    } finally {
      clearTimeout(timer);
    }
    if (Buffer.byteLength(body, "utf8") > JWKS_MAX_BYTES) {
      throw new Error("the JWKS is larger than 1 MiB");
    }
    const list = (JSON.parse(body) as { keys?: unknown } | null)?.keys;
    const keys = new Map<string, KeyObject>();
    if (Array.isArray(list)) {
      for (const k of list as unknown[]) {
        const kid = (k as { kid?: unknown } | null)?.kid;
        if (typeof kid !== "string" || kid === "") continue;
        const key = p256Key(k);
        if (key !== undefined) keys.set(kid, key);
      }
    }
    if (keys.size === 0) {
      throw new Error("the JWKS carries no P-256 key with a kid");
    }
    return keys;
  }
}

// ── single use ──────────────────────────────────────────────────────────────

/** Spends a jti once. `true` = this call spent it; `false` = already spent. */
export interface JtiStore {
  claimJti(jti: string, expUnix: number): Promise<boolean>;
}

/** In-memory {@link JtiStore} (tests, fixture backend). Entries live until exp. */
export class MemoryJtiStore implements JtiStore {
  readonly #seen = new Map<string, number>();

  claimJti(jti: string, expUnix: number): Promise<boolean> {
    const nowS = Math.floor(Date.now() / 1000);
    for (const [k, exp] of this.#seen) {
      if (exp + LEEWAY_S < nowS) this.#seen.delete(k);
    }
    if (this.#seen.has(jti)) return Promise.resolve(false);
    this.#seen.set(jti, expUnix);
    return Promise.resolve(true);
  }
}

// ── the verified act, on the async context ──────────────────────────────────

/** A verified assertion, as the write path sees it. */
export interface ActAuthor {
  /** `human/<handle>`: the full form, as recorded. */
  readonly authoredBy: string;
  /** `star/charon`. */
  readonly via: string;
  readonly jti: string;
  /** The REST path's verb, e.g. `write_container`. */
  readonly verb: string;
}

const authors = new AsyncLocalStorage<ActAuthor>();

/** Run `fn` with a verified author on its async context. Only the gate calls this. */
export function withActAuthor<T>(author: ActAuthor, fn: () => T): T {
  return authors.run(author, fn);
}

/** The verified author of the current request, or undefined (unattributed). */
export function actAuthor(): ActAuthor | undefined {
  return authors.getStore();
}

// ── verification ────────────────────────────────────────────────────────────

const B64URL = /^[A-Za-z0-9_-]+$/;
const JTI_RE = /^[0-9a-f]{32}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

function decodeSegment(seg: string): Buffer {
  if (!B64URL.test(seg)) throw invalid("malformed");
  return Buffer.from(seg, "base64url");
}

function jsonObject(buf: Buffer): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(buf.toString("utf8"));
  } catch {
    throw invalid("malformed");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw invalid("malformed");
  }
  return v as Record<string, unknown>;
}

const isInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v);

/** What {@link verifyActAssertion} is given. */
export interface VerifyInput {
  readonly token: string;
  /** The digest of the arguments actually received (args-digest.ts). */
  readonly argsSha256: string;
  readonly verb: string;
  readonly config: ActConfig;
  readonly keys: JwksCache | undefined;
  readonly jti: JtiStore;
  readonly nowMs?: number;
}

/**
 * Verify one assertion and spend its jti. Returns the author to attribute, or
 * throws an {@link ActRefusal}. Every check runs before the jti is spent, so a
 * request that fails any other test does not burn the one-time token.
 */
export async function verifyActAssertion(i: VerifyInput): Promise<ActAuthor> {
  const { config } = i;
  if (
    config.jwksUrl === "" ||
    config.issuer === "" ||
    config.trustDomain === "" ||
    i.keys === undefined
  ) {
    throw new ActRefusal(
      503,
      "act_assertion_unavailable",
      "act assertions are not configured on this star",
    );
  }
  const parts = i.token.split(".");
  if (parts.length !== 3) throw invalid("malformed");
  const [h, p, s] = parts as [string, string, string];
  const header = jsonObject(decodeSegment(h));
  if (header.alg !== "ES256") throw invalid("alg is not ES256");
  if (header.typ !== ACT_TYP) throw invalid(`typ is not ${ACT_TYP}`);
  if ("crit" in header) throw invalid("crit is not supported");
  const kid = header.kid;
  if (typeof kid !== "string" || kid === "") throw invalid("no kid");

  const sig = decodeSegment(s);
  if (sig.length !== 64) throw invalid("bad signature");
  const payload = decodeSegment(p);

  const key = await i.keys.keyFor(kid);
  if (key === undefined && i.keys.down) {
    throw new ActRefusal(
      503,
      "act_assertion_unavailable",
      "the Kairos keys could not be fetched",
    );
  }
  if (key === undefined) {
    throw new ActRefusal(
      401,
      "act_assertion_invalid",
      "no verification key for this assertion",
    );
  }
  const signed = Buffer.from(`${h}.${p}`, "ascii");
  let ok: boolean;
  try {
    ok = verify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    ok = false;
  }
  if (!ok) throw invalid("bad signature");

  const c = jsonObject(payload);
  const nowS = Math.floor((i.nowMs ?? Date.now()) / 1000);
  const td = config.trustDomain;
  if (c.iss !== config.issuer) throw invalid("wrong issuer");
  if (c.aud !== ACT_AUDIENCE) throw invalid("wrong audience");
  if (c.azp !== `spiffe://${td}/star/charon`) throw invalid("wrong azp");
  if (c.act !== ACT_CALLIOPE_WRITE) throw invalid("wrong act");
  if (!Array.isArray(c.amr) || !c.amr.includes(AMR_PASSKEY)) {
    throw invalid("amr lacks passkey");
  }
  const { iat, nbf, exp } = c;
  if (!isInt(iat) || !isInt(nbf) || !isInt(exp)) throw invalid("bad times");
  if (exp <= nbf || exp - iat > MAX_LIFETIME_S) throw invalid("bad lifetime");
  if (nowS >= exp + LEEWAY_S) {
    throw new ActRefusal(401, "act_assertion_invalid", "expired");
  }
  if (nowS + LEEWAY_S < nbf || nowS + LEEWAY_S < iat) {
    throw invalid("not yet valid");
  }
  const prefix = `spiffe://${td}/human/`;
  const sub = c.sub;
  if (typeof sub !== "string" || !sub.startsWith(prefix)) {
    throw invalid("sub is not a human of this trust domain");
  }
  const handle = sub.slice(prefix.length);
  if (!HANDLE_RE.test(handle)) throw invalid("sub is not a human handle");
  const digest = c.args_sha256;
  if (typeof digest !== "string" || !SHA_RE.test(digest)) {
    throw invalid("incomplete binding");
  }
  const want = Buffer.from(i.argsSha256, "utf8");
  const have = Buffer.from(digest, "utf8");
  if (want.length !== have.length || !timingSafeEqual(want, have)) {
    throw invalid("args do not match the assertion");
  }
  const jti = c.jti;
  if (typeof jti !== "string" || !JTI_RE.test(jti)) {
    throw invalid("incomplete binding");
  }

  let fresh: boolean;
  try {
    fresh = await i.jti.claimJti(jti, exp);
  } catch (err) {
    process.stderr.write(
      `calliope-act: the jti store failed err=${err instanceof Error ? err.message : String(err)}\n`,
    );
    throw new ActRefusal(
      503,
      "act_assertion_unavailable",
      "single use could not be recorded",
    );
  }
  if (!fresh) {
    throw new ActRefusal(401, "act_assertion_replayed", "already used");
  }
  return {
    authoredBy: `human/${handle}`,
    via: VIA_CHARON,
    jti,
    verb: i.verb.slice("/v1/".length).split("/")[0] ?? "",
  };
}
