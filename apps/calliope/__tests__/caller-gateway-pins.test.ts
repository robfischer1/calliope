/**
 * Who speaks for the gateway's `hades/principal` stamp, pinned peer-field by
 * peer-field: a peer is the gateway only when its kind, name, SPIFFE id and
 * attestation ALL say so, and a stamp counts only when it is a non-empty
 * string. Each case differs from the real gateway in exactly one field.
 */

import type { Peer } from "@forge/stellar-core-ts";
import { META_PRINCIPAL } from "@forge/stellar-core-ts/pep";
import { describe, expect, it } from "vitest";
import { callerPrincipal, NOMOS_PRINCIPAL } from "../src/caller.js";

const GATEWAY_ID = "spiffe://notusmi.com/star/hades";
const HADES: Peer = { spiffeId: GATEWAY_ID, kind: "star", name: "hades" };
const stamp = (v: unknown): Record<string, unknown> => ({
  [META_PRINCIPAL]: v,
});

describe("callerPrincipal: only the real gateway speaks for the stamp", () => {
  it("the real gateway's stamp is the caller", () => {
    expect(callerPrincipal(stamp(NOMOS_PRINCIPAL), HADES)).toBe(
      NOMOS_PRINCIPAL,
    );
  });

  it("a non-star peer carrying the gateway's id and name is only itself", () => {
    const impostor: Peer = { ...HADES, kind: "session" };
    expect(callerPrincipal(stamp(NOMOS_PRINCIPAL), impostor)).toBe(GATEWAY_ID);
  });

  it("a star not named hades carrying the gateway's id is only itself", () => {
    const impostor: Peer = { ...HADES, name: "athena" };
    expect(callerPrincipal(stamp(NOMOS_PRINCIPAL), impostor)).toBe(GATEWAY_ID);
  });
});

describe("callerPrincipal: the stamp must be a non-empty string", () => {
  it("a non-string stamp is nobody", () => {
    expect(callerPrincipal(stamp(42), HADES)).toBeUndefined();
    expect(callerPrincipal(stamp({}), HADES)).toBeUndefined();
    expect(callerPrincipal(stamp(null), HADES)).toBeUndefined();
  });

  it("an empty stamp is nobody", () => {
    expect(callerPrincipal(stamp(""), HADES)).toBeUndefined();
  });

  it("an absent stamp is nobody", () => {
    expect(callerPrincipal({}, HADES)).toBeUndefined();
    expect(callerPrincipal(undefined, HADES)).toBeUndefined();
  });
});
