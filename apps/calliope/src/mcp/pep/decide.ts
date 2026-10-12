/**
 * The endpoint PEP's decision: what a star makes of each inbound call from the
 * caller's verified identity and its own composed orbit sidecar, with zero
 * network round trips. The TS peer of stellar-core-go `policy/decide.go`; the
 * cross-port fixture set (`__tests__/fixtures/pep/decisions.json`, copied from
 * the Go repo's `policy/testdata`) replays against it case for case.
 *
 * THE DECISION, cheapest first:
 *
 *  1. Who is calling: the verified peer off the connection, never a header or an
 *     argument. No verified peer: `unidentified`.
 *  2. The gateway. North-south traffic arrives AS hades (the gateway's SVID) and
 *     the session behind it travels in the request `_meta`, stamped by the
 *     gateway under keys a client cannot occupy. When, and ONLY when, the
 *     verified peer is hades, that stamp names the caller and the call takes the
 *     non-service path. Any other peer's `_meta` is its own claim and is ignored.
 *  3. A star caller: is there a `[[produces]]` edge for it, and does that edge
 *     carry this verb (the star's own unprefixed verb name)?
 *  4. A CI lane's run (`job`) or a CI job's workload identity (`ci`): the same
 *     edge check, held to consumer `job.<lane>` / `ci.<lane>`.
 *  5. Any other verified caller (session, human): the non-service path.
 *
 * The non-service path is the policy plane's question. This port has no policy
 * plane client (Go asks one when `STELLAR_PDP_URL` is set; calliope's flux
 * manifest sets none), so it answers what Go answers with no PDP configured:
 * `consult` / `pdp_not_consulted`, carrying the principal that would be asked
 * about.
 *
 * Pure: no network, no clock, no mode.
 */

import { GATEWAY_STAR } from "@forge/stellar-core-ts";
import type { Peer } from "@forge/stellar-core-ts";
import type { Acl } from "./acl.js";

/** The gateway's `_meta` stamp keys (hades internal/edge/mcp.go). */
export const META_PRINCIPAL = "hades/principal";
export const META_PRINCIPAL_TYPE = "hades/principal-type";

/** What ENFORCEMENT would do, independent of the mode. */
export type Verdict = "allow" | "deny" | "consult";

/** The closed reason set, so a dashboard can enumerate them. */
export const REASONS = [
  "edge_allows",
  "no_edge",
  "verb_not_on_edge",
  "unidentified",
  "no_acl",
  "pdp_not_consulted",
  "edge_not_approved",
] as const;
export type Reason = (typeof REASONS)[number];

/**
 * One adjudication. `contract` names the edge consulted, when one was.
 * `principal` / `principalType` name the caller the non-service path would ask
 * about: the gateway's stamp, or a directly-dialling peer's own identity. All
 * three are "" when absent.
 */
export interface Decision {
  verdict: Verdict;
  reason: Reason;
  contract: string;
  principal: string;
  principalType: string;
}

/** One inbound call as the PEP sees it. */
export interface Input {
  /** The caller as the connection proved it; undefined proved nothing. */
  peer: Peer | undefined;
  /** The request's `_meta`. Read only when the peer is the gateway. */
  meta?: Readonly<Record<string, unknown>> | undefined;
  /** The tool name as called. */
  verb: string;
}

const decision = (
  verdict: Verdict,
  reason: Reason,
  extra: Partial<Decision> = {},
): Decision => ({
  verdict,
  reason,
  contract: "",
  principal: "",
  principalType: "",
  ...extra,
});

/** A CI lane's run is held to consumer `job.<lane>` (orbits/<producer>-job.<lane>.toml). */
export const JOB_CONSUMER_PREFIX = "job.";

/**
 * A CI job's workload identity (a `ci` peer, R-D20) is held to consumer
 * `ci.<lane>` (orbits/<producer>-ci.<lane>.toml), however many repos, refs and
 * runs carry that lane. A job.<lane> edge does not admit a ci, nor the reverse.
 */
export const CI_CONSUMER_PREFIX = "ci.";

/**
 * The `[[produces]]` consumer a peer's edge is held to: a star's bare name,
 * `job.<lane>` for a CI lane's run (`spiffe://<td>/job/<lane>/<id>`),
 * `ci.<lane>` for a CI job's workload identity
 * (`spiffe://<td>/ci/<repo>/<lane>/<ref>/<run>`), and "" for every other
 * caller (the two-segment `ci/<ns>/<sa>` runner among them), which takes the
 * non-service path.
 */
export function consumerOf(peer: Peer | undefined): string {
  if (peer === undefined) return "";
  if (peer.kind === "job") {
    const rest = peer.name.split("/job/")[1] ?? "";
    const lane = rest.split("/", 1)[0] ?? "";
    return lane === "" ? "" : JOB_CONSUMER_PREFIX + lane;
  }
  if (peer.kind === "ci") {
    // Exactly four segments after ci/, as the SDK typed it: repo, lane, ref, run.
    const parts = (peer.name.split("/ci/")[1] ?? "").split("/");
    const lane = parts.length === 4 ? (parts[1] ?? "") : "";
    return lane === "" ? "" : CI_CONSUMER_PREFIX + lane;
  }
  return peer.kind === "star" ? peer.name : "";
}

/**
 * The gateway's stamp, read the way every star read it before the identity
 * core (Go's `legacyStamp`, which acts unless `STELLAR_IDENTITY_MODE=enforce`):
 * whatever the gateway wrote under the two keys, taken as it stands, and a stamp
 * when the type is a non-empty string.
 */
function legacyStamp(
  meta: Readonly<Record<string, unknown>> | undefined,
): Decision | undefined {
  const principalType = meta?.[META_PRINCIPAL_TYPE];
  if (typeof principalType !== "string" || principalType === "")
    return undefined;
  const principal = meta?.[META_PRINCIPAL];
  return decision("consult", "pdp_not_consulted", {
    principal: typeof principal === "string" ? principal : "",
    principalType,
  });
}

/**
 * Adjudicate `input`. An undefined `acl` is "no sidecar": star callers get
 * `no_acl`, and nothing else changes: the gateway and non-star paths never read it.
 */
export function decide(acl: Acl | undefined, input: Input): Decision {
  const { peer } = input;
  if (peer === undefined) return decision("deny", "unidentified");
  if (peer.kind === "star" && peer.name === GATEWAY_STAR) {
    const stamped = legacyStamp(input.meta);
    if (stamped !== undefined) return stamped;
    // No stamp: hades calling as itself (or for an anonymous caller, which
    // stamps nothing and is indistinguishable here). A star like any other,
    // held to its own edge below.
  }
  const consumer = consumerOf(peer);
  if (consumer === "") {
    return decision("consult", "pdp_not_consulted", {
      principal: peer.spiffeId,
      principalType: peer.kind,
    });
  }
  if (acl === undefined) return decision("deny", "no_acl");
  const entry = acl.entry(consumer);
  if (entry === undefined) return decision("deny", "no_edge");
  if (!entry.verbs.has(input.verb)) {
    return decision("deny", "verb_not_on_edge", { contract: entry.contract });
  }
  return decision("allow", "edge_allows", { contract: entry.contract });
}
