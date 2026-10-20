// Test-only helpers for the endpoint PEP suites: a typed Peer from a SPIFFE id
// through the REAL certificate path (`peerFromCertificate`, the typing rule the
// fleet's doors use), and a recording request log.

import { peerFromCertificate, RequestLog } from "@forge/stellar-core-ts";
import type { Peer, RequestRecord } from "@forge/stellar-core-ts";
import { withDenyDecision } from "@forge/stellar-core-ts/pep";
import { makeIdentity } from "./tls-identity.js";

const peers = new Map<string, Peer | undefined>();

/**
 * The peer a verified leaf carrying `spiffeId` names. `undefined` (no
 * certificate) is the plaintext caller; `"untyped"` is a certificate with no
 * SPIFFE id this fleet types. Both read as no peer.
 */
export function peerFor(spiffeId: string | undefined): Peer | undefined {
  if (spiffeId === undefined || spiffeId === "") return undefined;
  if (!peers.has(spiffeId)) {
    const san =
      spiffeId === "untyped" ? "DNS:untyped.example" : `URI:${spiffeId}`;
    peers.set(
      spiffeId,
      peerFromCertificate(
        makeIdentity(san, `pep-${String(peers.size)}`).cert,
      ) ?? undefined,
    );
  }
  return peers.get(spiffeId);
}

/** A request log that keeps every record, through the same sink wrapper the
 *  production witness uses (so a refused call's `decision: deny` is visible). */
export function recordingLog(star: string): {
  log: RequestLog;
  got: RequestRecord[];
} {
  const got: RequestRecord[] = [];
  const log = new RequestLog(star, {
    sink: withDenyDecision((r) => {
      got.push(r);
    }),
  });
  return { log, got };
}

export const SESSION =
  "spiffe://notusmi.com/session/5906d6fc-aba9-49ab-a8af-3b1e56409c49";
