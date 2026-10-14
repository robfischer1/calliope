/**
 * The policy-plane (PDP) client the non-service path asks. The TS peer of
 * stellar-core-go `policy/ouranos.go` + `policy/consult.go`. stellar-core-ts
 * has no PDP client (PARITY.md names it a deliberate non-goal), so this is
 * hand-rolled here, line for line against the Go lift:
 *
 *     POST <…/v1/data/authz/endpoint_decision>
 *     {"input": {"principal": {"type", "subject"}, "verb", "star", "args"?: {"action"}}}
 *     -> {"result": {"allow", "reasons"}}
 *
 * A star asks the sibling `endpoint_decision` document with the BARE verb it
 * serves; the bundle joins the gateway prefix itself, so a prefix added here
 * would double. Only the `action` discriminator of the arguments crosses the
 * wire, never the payload, and the `args` object rides only when the action is
 * known.
 *
 * FAULT POSTURE: fail-open. A transport fault, timeout, non-200 or undecodable
 * body means the plane did not answer; {@link Ouranos.decide} then returns the
 * posture's verdict (allow) BESIDE an `error`, so the PEP records the fault as
 * its own fact (`pdp_error`) instead of reading it as an allow. A real deny from
 * an answering plane is always a deny. Enforce closes `pdp_error` (enforce.ts).
 *
 * CACHE: 30 s, keyed {type, subject, verb, star, action, epoch}; faults are
 * never cached. The epoch is the served policy's identity (the bundle
 * manifest's revision, else the die-standing digest), re-read at most once per
 * interval, piggybacked on a decision; a failed read keeps the last epoch.
 */

import type { Decision } from "./decide.js";

/** Names the policy plane's decision URL (…/v1/data/authz/decision). */
export const ENV_PDP = "STELLAR_PDP_URL";

/** One consult from a star's PEP is bounded well under hades' 5 s. */
export const WITNESS_CONSULT_TIMEOUT_MS = 1_000;
export const DEFAULT_CONSULT_TIMEOUT_MS = 5_000;
export const DEFAULT_CACHE_TTL_MS = 30_000;

/** The reasons a consulted decision carries. */
export const REASON_PDP_ALLOWS = "pdp_allows";
export const REASON_PDP_DENIES = "pdp_denies";
export const REASON_PDP_ERROR = "pdp_error";

/** The verdict reasons the client itself mints. */
export const PDP_REASON_UNIDENTIFIABLE = "unidentifiable caller";
export const PDP_REASON_UNMAPPED = "caller not permitted (unmapped subject)";
export const PDP_REASON_DENIED = "denied by policy";
export const PDP_REASON_FAIL_OPEN =
  "policy unavailable — permitted (fail-open)";
export const PDP_REASON_UNAVAILABLE = "policy decision unavailable";

/** One question to the policy plane. `action` "" = unknown (omitted on the wire). */
export interface Query {
  principal: string;
  principalType: string;
  verb: string;
  star: string;
  action: string;
}

/** The plane's answer. `reason` is set on a deny. */
export interface PdpVerdict {
  allow: boolean;
  reason?: string;
}

/** A verdict, plus the fault when the plane did not answer. */
export interface PdpAnswer {
  verdict: PdpVerdict;
  error?: Error;
}

/** The policy plane, as the non-service path asks it. */
export interface Pdp {
  decide(q: Query): Promise<PdpAnswer>;
}

/**
 * `d` once the plane has answered (or failed to). The principal `d` names is
 * kept: it is who was asked about. A fault carries the client's posture as the
 * verdict (allow under fail-open) and the reason `pdp_error`.
 */
export function consulted(d: Decision, answer: PdpAnswer): Decision {
  if (answer.error !== undefined) {
    return {
      ...d,
      verdict: answer.verdict.allow ? "allow" : "deny",
      reason: REASON_PDP_ERROR,
    };
  }
  return answer.verdict.allow
    ? { ...d, verdict: "allow", reason: REASON_PDP_ALLOWS }
    : { ...d, verdict: "deny", reason: REASON_PDP_DENIES };
}

/**
 * The `action` discriminator of a verb's raw arguments, as hades extracts it:
 * a string `action` of an object, else "" (unknown).
 */
export function actionOf(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const action = (args as { action?: unknown }).action;
  return typeof action === "string" ? action : "";
}

/** Every principal type whose subject is an identity rather than a secret and
 *  so crosses the wire verbatim (Go's `passThrough`; `agent` is absent on
 *  purpose: its subject is a bearer token, denied locally when unmapped). */
const PASS_THROUGH = new Set([
  "human",
  "session",
  "star",
  "daemon",
  "runner",
  "appliance",
  "ci",
]);

const DECISION_SUFFIX = "/v1/data/authz/decision";

function deriveFrom(decisionUrl: string, path: string): string {
  return decisionUrl.endsWith(DECISION_SUFFIX)
    ? decisionUrl.slice(0, -DECISION_SUFFIX.length) + path
    : "";
}

export const deriveStandingUrl = (u: string): string =>
  deriveFrom(u, "/v1/data/die_standing");
export const deriveManifestUrl = (u: string): string =>
  deriveFrom(u, "/v1/data/system/bundles/policy/manifest");
export const deriveEndpointDecisionUrl = (u: string): string =>
  deriveFrom(u, "/v1/data/authz/endpoint_decision");

/** The input document, built exactly as hades builds it. */
export function consultBody(q: Query): string {
  const input: Record<string, unknown> = {
    principal: { type: q.principalType, subject: q.principal },
    verb: q.verb,
    star: q.star,
  };
  if (q.action !== "") input.args = { action: q.action };
  return JSON.stringify({ input });
}

export interface OuranosOptions {
  /** The decision endpoint (…/v1/data/authz/endpoint_decision). */
  url: string;
  standingUrl?: string;
  manifestUrl?: string;
  /** Allow on an unanswered consult (default true). */
  failOpen?: boolean;
  ttlMs?: number;
  timeoutMs?: number;
  /** Epoch re-read interval; default the TTL. */
  standingIntervalMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

interface CacheEntry {
  verdict: PdpVerdict;
  expires: number;
}

/** The PDP client. */
export class Ouranos implements Pdp {
  private readonly cache = new Map<string, CacheEntry>();
  private epoch = "";
  private epochChecked = Number.NEGATIVE_INFINITY;
  private readonly failOpen: boolean;
  private readonly ttl: number;
  private readonly timeout: number;
  private readonly doFetch: typeof fetch;
  private readonly clock: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly o: OuranosOptions) {
    this.failOpen = o.failOpen ?? true;
    this.ttl = o.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeout = o.timeoutMs ?? DEFAULT_CONSULT_TIMEOUT_MS;
    this.doFetch = o.fetch ?? fetch;
    this.clock = o.now ?? Date.now;
    this.log =
      o.log ??
      ((line) => {
        process.stderr.write(`${line}\n`);
      });
  }

  /** Identity gates, then cache, then consult, then cache. */
  async decide(q: Query): Promise<PdpAnswer> {
    if (q.principal === "") {
      return { verdict: { allow: false, reason: PDP_REASON_UNIDENTIFIABLE } };
    }
    // No Subjects map is wired for a star's PEP: a non-pass-through type
    // (agent) is unmapped and denied before the wire.
    if (!PASS_THROUGH.has(q.principalType)) {
      return { verdict: { allow: false, reason: PDP_REASON_UNMAPPED } };
    }
    const key = JSON.stringify([
      q.principalType,
      q.principal,
      q.verb,
      q.star,
      q.action,
      await this.currentEpoch(),
    ]);
    const hit = this.cache.get(key);
    if (hit !== undefined && this.clock() <= hit.expires) {
      return { verdict: hit.verdict };
    }
    try {
      const verdict = await this.consult(q);
      this.cache.set(key, { verdict, expires: this.clock() + this.ttl });
      return { verdict };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return { verdict: this.unanswered(q, error), error };
    }
  }

  private unanswered(q: Query, err: Error): PdpVerdict {
    if (!this.failOpen) {
      this.log(
        `pdp: consult failed — denying (fail-closed) verb=${q.verb} star=${q.star} err=${err.message}`,
      );
      return { allow: false, reason: PDP_REASON_UNAVAILABLE };
    }
    this.log(
      `pdp: consult failed — PERMITTING (fail-open) verb=${q.verb} star=${q.star} ` +
        `principal_type=${q.principalType} err=${err.message}`,
    );
    return { allow: true, reason: PDP_REASON_FAIL_OPEN };
  }

  private async consult(q: Query): Promise<PdpVerdict> {
    let wire: { result?: { allow?: unknown; reasons?: unknown } };
    try {
      wire = (await this.json(
        "POST",
        this.o.url,
        consultBody(q),
      )) as typeof wire;
    } catch (err) {
      throw new Error(
        `authz consult: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (wire.result?.allow === true) return { allow: true };
    const reasons = wire.result?.reasons;
    const first = Array.isArray(reasons) ? (reasons[0] as unknown) : undefined;
    return {
      allow: false,
      reason: typeof first === "string" ? first : PDP_REASON_DENIED,
    };
  }

  /** One bounded request (a body means POST JSON); decodes a 200 answer. */
  private async json(
    method: string,
    url: string,
    body?: string,
  ): Promise<unknown> {
    const init: RequestInit = {
      method,
      signal: AbortSignal.timeout(this.timeout),
    };
    if (body !== undefined) {
      init.body = body;
      init.headers = { "Content-Type": "application/json" };
    }
    const resp = await this.doFetch(url, init);
    if (resp.status !== 200)
      throw new Error(`PDP answered ${String(resp.status)}`);
    try {
      return (await resp.json()) as unknown;
    } catch (err) {
      throw new Error(
        `bad body: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  /** The served policy's identity for the cache key: one read per interval. */
  private async currentEpoch(): Promise<string> {
    if ((this.o.standingUrl ?? "") === "" && (this.o.manifestUrl ?? "") === "")
      return "";
    const interval = this.o.standingIntervalMs ?? this.ttl;
    const now = this.clock();
    if (now - this.epochChecked < interval) return this.epoch;
    this.epochChecked = now; // claimed before the await: no stampede
    try {
      this.epoch = await this.fetchEpoch();
    } catch (err) {
      this.log(
        `pdp: epoch read failed — keeping the previous policy epoch: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.epoch;
  }

  /** The manifest's revision, else the die-standing digest. */
  private async fetchEpoch(): Promise<string> {
    if ((this.o.manifestUrl ?? "") !== "") {
      try {
        const m = (await this.json("GET", this.o.manifestUrl ?? "")) as {
          result?: { revision?: unknown };
        };
        const rev = m.result?.revision;
        if (typeof rev === "string" && rev !== "") return rev;
      } catch {
        // fall through to the standing digest
      }
    }
    if ((this.o.standingUrl ?? "") === "")
      throw new Error("standing read: no standing or manifest source");
    const s = (await this.json("GET", this.o.standingUrl ?? "")) as {
      result?: { digest?: unknown };
    };
    const digest = s.result?.digest;
    if (typeof digest !== "string" || digest === "")
      throw new Error("standing read: doc carries no digest");
    return digest;
  }
}

/**
 * The star's PDP client when {@link ENV_PDP} names one, else undefined. A URL
 * that does not end in `/v1/data/authz/decision` derives no endpoint document:
 * consults are off, said once.
 */
export function pdpFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (l) => {
    process.stderr.write(`${l}\n`);
  },
): Pdp | undefined {
  const url = env[ENV_PDP] ?? "";
  if (url === "") return undefined;
  const endpoint = deriveEndpointDecisionUrl(url);
  if (endpoint === "") {
    log(
      `pep: ${ENV_PDP} does not end in ${DECISION_SUFFIX} — the endpoint decision cannot be derived; consults are off (${url})`,
    );
    return undefined;
  }
  return new Ouranos({
    url: endpoint,
    standingUrl: deriveStandingUrl(url),
    manifestUrl: deriveManifestUrl(url),
    failOpen: true,
    timeoutMs: WITNESS_CONSULT_TIMEOUT_MS,
    log,
  });
}
