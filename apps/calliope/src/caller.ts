/**
 * Who is calling, as a verb handler may read it: the VERIFIED peer the door
 * stamped on the request's async context (`withPeerContext` in http.ts, or the
 * REST face's Cilium X-Forge-Peer stamp), never an argument.
 *
 * Two shapes name a caller:
 *  - a direct call: the caller's SPIFFE id, from the REST door's Cilium stamp
 *    (the mTLS door is gone, REST mesh P7).
 *  - a call through the gateway: the verified peer is hades, and the session
 *    or star behind it is the gateway's `hades/principal` `_meta` stamp. Only
 *    a hades peer in this trust domain, named by its certificate or by the
 *    plaintext network fence, speaks for that stamp; a hades the Cilium stamp
 *    named does not (stellar-core-ts `honoursHadesMeta`, mirrored here because
 *    the package does not export it).
 *
 * A caller that proved nothing, or a stamp from any other peer, is
 * `undefined`. Nothing here refuses: a handler decides what an identity may do.
 */

import { GATEWAY_STAR, peerFrom } from "@forge/stellar-core-ts";
import type { Peer } from "@forge/stellar-core-ts";
import { META_PRINCIPAL } from "@forge/stellar-core-ts/pep";

/** The trust domain the identities below live in. */
export const TRUST_DOMAIN = "notusmi.com";

/** nomos, the governance star: the one caller delete_note lets hide a
 *  Governance note (its prose law's Calliope home). */
export const NOMOS_PRINCIPAL = `spiffe://${TRUST_DOMAIN}/star/nomos`;

const GATEWAY_ID = `spiffe://${TRUST_DOMAIN}/star/${GATEWAY_STAR}`;

/** Whether `peer` is the gateway and so speaks for its `hades/*` stamp. */
function isGateway(peer: Peer): boolean {
  return (
    peer.kind === "star" &&
    peer.name === GATEWAY_STAR &&
    peer.spiffeId === GATEWAY_ID &&
    peer.attest !== "cilium-stamp"
  );
}

/**
 * The SPIFFE id of the caller of the current request, or `undefined`.
 * `peer` defaults to the async context's; `meta` is the request's `_meta`.
 */
export function callerPrincipal(
  meta: Readonly<Record<string, unknown>> | undefined,
  peer: Peer | undefined = peerFrom(),
): string | undefined {
  if (peer === undefined) return undefined;
  if (isGateway(peer)) {
    const stamped = meta?.[META_PRINCIPAL];
    return typeof stamped === "string" && stamped !== "" ? stamped : undefined;
  }
  // A direct caller counts only when its certificate proved it: a network
  // fence or a Cilium stamp names a ServiceAccount, not a mutual TLS peer.
  return peer.attest === undefined ? peer.spiffeId : undefined;
}
