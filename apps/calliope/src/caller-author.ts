/**
 * The verified caller as a write's author: the mesh's answer to "who is this
 * write for" when no act assertion rides the request.
 *
 * The prime waypoint verifies a Kairos token on the way in and writes its
 * claims as `x-kairos-*` (flux infrastructure/prime-waypoint.yaml,
 * kairos-session-stars, which targets Service/calliope). Its Envoy deletes a
 * client's copy of every header it writes before verifying anything (jwt_authn
 * sanitizePayloadHeaders, measured on Kairos 2026-11-13), and it overwrites
 * X-Forwarded-Client-Cert on every request. This reads the pair the way
 * stellar-core-go `caller` does: the subject from `x-kairos-sub`, the calling
 * workload from the one XFCC element. A request with no single XFCC element
 * did not come through the waypoint, so its `x-kairos-sub` names no one.
 *
 * Only a human of this trust domain is recorded (`human/<handle>`), the same
 * shape the act assertion records; a session or star subject is the write's
 * ordinary author and adds no row.
 */

import { HANDLE_RE } from "./act-assertion.js";
import type { ActAuthor } from "./act-assertion.js";

/** The claims header the waypoint writes from the verified token's `sub`. */
export const HEADER_SUBJECT = "x-kairos-sub";
/** The verified token's transaction id, when it carries one. */
export const HEADER_TXN = "x-kairos-txn";
/** The waypoint's record of the calling workload. */
export const HEADER_XFCC = "x-forwarded-client-cert";

const SPIFFE = "spiffe://";

/** The slice of the request's headers this reads (RestHeaders is case-insensitive). */
export interface HeaderBag {
  getAll(name: string): readonly string[];
}

/** The one value a header carries, "" for none or several. */
function single(h: HeaderBag, name: string): string {
  const v = h.getAll(name);
  return v.length === 1 ? (v[0] ?? "").trim() : "";
}

/** The calling workload's SPIFFE id from one XFCC element, "" otherwise. */
export function xfccService(h: HeaderBag): string {
  const element = single(h, HEADER_XFCC);
  if (element === "" || element.includes(",")) return "";
  let uri = "";
  for (const field of element.split(";")) {
    const eq = field.indexOf("=");
    if (eq < 0) continue;
    if (field.slice(0, eq).trim().toLowerCase() !== "uri") continue;
    if (uri !== "") return "";
    uri = field
      .slice(eq + 1)
      .trim()
      .replace(/^"|"$/g, "");
  }
  return uri.startsWith(SPIFFE) && uri.length > SPIFFE.length ? uri : "";
}

/**
 * The human author the waypoint vouches for, or undefined: no single
 * `x-kairos-sub`, no waypoint (XFCC), or a subject that is not
 * `spiffe://<td>/human/<handle>`.
 */
export function callerAuthor(
  h: HeaderBag,
  trustDomain: string,
  verb: string,
): ActAuthor | undefined {
  if (trustDomain === "") return undefined;
  const via = xfccService(h);
  if (via === "") return undefined;
  const sub = single(h, HEADER_SUBJECT);
  const prefix = `${SPIFFE}${trustDomain}/human/`;
  if (!sub.startsWith(prefix)) return undefined;
  const handle = sub.slice(prefix.length);
  if (!HANDLE_RE.test(handle)) return undefined;
  const txn = single(h, HEADER_TXN);
  return {
    authoredBy: `human/${handle}`,
    via,
    jti: txn === "" ? "" : `txn:${txn}`,
    verb,
  };
}
