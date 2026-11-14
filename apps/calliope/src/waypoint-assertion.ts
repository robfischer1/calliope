/**
 * The Kairos act assertion as the waypoint hands it over: claims, not a token.
 *
 * The prime waypoint verifies the assertion carried in `X-Act-Assertion`
 * (flux infrastructure/act-assertion.yaml, kairos-act-calliope: issuer Kairos,
 * audience calliope), removes it, and writes its claims as
 * `x-kairos-assertion-*`; mesh-opa checks the act and the window. Its
 * waypoint-claims-strip deletes a client's copy of every `x-kairos-*` header
 * first. calliope compares what is left: the act is this verb, args_sha256 is
 * the digest of the arguments about to run, and the jti has not been spent.
 * No signature, key or JWKS is read here.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { canonicalAssertion } from "@forge/stellar-core-ts/pep";
import { HANDLE_RE } from "./act-assertion.js";
import type { HeaderBag } from "./caller-author.js";

export const HEADER_ASSERTION_ACT = "x-kairos-assertion-act";
export const HEADER_ASSERTION_JTI = "x-kairos-assertion-jti";
export const HEADER_ASSERTION_ARGS = "x-kairos-assertion-args-sha256";
export const HEADER_ASSERTION_AZP = "x-kairos-assertion-azp";

const HEADERS = [
  HEADER_ASSERTION_ACT,
  HEADER_ASSERTION_JTI,
  HEADER_ASSERTION_ARGS,
  HEADER_ASSERTION_AZP,
] as const;

/** The tool name a REST verb's assertion names: `calliope_<verb>`. */
export const TOOL_PREFIX = "calliope_";

/** An assertion's claims, each the one value its header carried. */
export interface WaypointAssertion {
  readonly act: string;
  readonly jti: string;
  readonly argsSha256: string;
  readonly azp: string;
}

/**
 * The claims, `"incomplete"` when some claims header is present but not every
 * one carries exactly one value, or undefined when none is present.
 */
export function waypointAssertion(
  h: HeaderBag,
): WaypointAssertion | "incomplete" | undefined {
  const values = HEADERS.map((n) => h.getAll(n));
  if (values.every((v) => v.length === 0)) return undefined;
  const one = values.map((v) => (v.length === 1 ? (v[0] ?? "").trim() : ""));
  if (one.some((v) => v === "")) return "incomplete";
  const [act = "", jti = "", argsSha256 = "", azp = ""] = one;
  return { act, jti, argsSha256, azp };
}

/**
 * The digest an assertion for `tool` over `args` carries: lowercase hex
 * SHA-256 of `{tool}\x1f{canonical(args)}`, the payload Kairos binds an
 * approval to (stellar-core-go canonical.Assertion).
 */
export function assertionArgsSha256(tool: string, args: unknown): string {
  return createHash("sha256")
    .update(canonicalAssertion(tool, args), "utf8")
    .digest("hex");
}

/** Whether `have` is `want`, compared in constant time. */
export function digestMatches(have: string, want: string): boolean {
  const a = Buffer.from(have.toLowerCase(), "utf8");
  const b = Buffer.from(want, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The handle `azp` names (`spiffe://<td>/human/<handle>`), or undefined. */
export function humanHandle(
  azp: string,
  trustDomain: string,
): string | undefined {
  const prefix = `spiffe://${trustDomain}/human/`;
  if (trustDomain === "" || !azp.startsWith(prefix)) return undefined;
  const handle = azp.slice(prefix.length);
  return HANDLE_RE.test(handle) ? handle : undefined;
}
