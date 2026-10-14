/**
 * ENFORCE: what it refuses and why (Constellation Mesh W5). The TS peer of
 * stellar-core-go `policy/enforce.go`. {@link decide}'s verdict is shared with
 * witness mode, so the evidence witness mode gathered is the evidence enforce
 * acts on. Enforce then closes two gaps witness only records:
 *
 *  - a consult nobody answered (no PDP wired, or an agent stamped with a type
 *    and no subject to ask about): refused, `pdp_not_consulted`;
 *  - `pdp_error`: refused, whatever the PDP client's fail-open posture said
 *    ("fail closed like everything else");
 *  - an edge that allows the verb but whose contract is still `generated`:
 *    refused, `edge_not_approved`. A witnessed baseline nobody ratified is not
 *    a grant.
 *
 * Everything else is {@link decide}'s: `no_acl`, `no_edge`, `verb_not_on_edge`
 * and `unidentified` refuse; `edge_allows` (approved) allows.
 */

import type { Acl } from "./acl.js";
import type { Decision } from "./decide.js";

/** `d` as an enforcing PEP acts on it. `consumer` is the calling star's bare
 *  name ("" for any other caller). */
export function enforced(
  acl: Acl | undefined,
  consumer: string,
  d: Decision,
): Decision {
  if (d.verdict === "consult" || d.reason === "pdp_error")
    return { ...d, verdict: "deny" };
  if (d.reason === "edge_allows" && acl?.approved(consumer) !== true) {
    return { ...d, verdict: "deny", reason: "edge_not_approved" };
  }
  return d;
}

/** The contract a star caller's refusal is fixed in: the producer is the
 *  callee (this star), the consumer the caller. */
export function contractFile(producer: string, consumer: string): string {
  return `foundry-dies/orbits/${producer}-${consumer}.toml`;
}

/** Where the policy plane's grants live: a gateway or non-star caller's
 *  refusal is fixed there, not in a contract. */
export const GRANTS_FILE = "foundry-dies/policy/authz_grants/data.json";

/** What a refused caller is told, as a structured tool error. */
export interface Refused {
  refused: "pep";
  star: string;
  verb: string;
  caller: string;
  principal?: string;
  reason: string;
  fix: string;
}

function fixFor(star: string, consumer: string, d: Decision): string {
  switch (d.reason) {
    case "unidentified":
      return "dial the star's mTLS port (plaintext port + 1) presenting a SPIFFE SVID";
    case "pdp_not_consulted":
    case "pdp_denies":
    case "pdp_error":
      return GRANTS_FILE;
    case "no_acl":
      return `the star's orbit sidecar (ConfigMap orbit-${star}), composed from ${contractFile(star, consumer)}`;
    default:
      return contractFile(star, consumer);
  }
}

/** The tool result a refused call answers with. */
export interface RefusalResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: Refused;
  isError: true;
}

/**
 * The tool error a refused call answers with. A tool error, not a JSON-RPC
 * error: the star DID answer, so the gateway relays it and does not count it as
 * an unanswered call against the star's standing.
 */
export function refusal(
  star: string,
  verb: string,
  caller: string,
  consumer: string,
  d: Decision,
): RefusalResult {
  const body: Refused = {
    refused: "pep",
    star,
    verb,
    caller: caller === "" ? "unidentified" : caller,
    ...(d.principal === "" ? {} : { principal: d.principal }),
    reason: d.reason,
    fix: fixFor(star, consumer, d),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    isError: true,
  };
}
