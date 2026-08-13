/**
 * F2 (025) — validateWriteProvenance: the offset⇒session-principal invariant.
 *
 * A log offset without a session author is a guess about provenance; the
 * guard makes it structurally impossible on every write path (the boundary
 * enforces it for callers; the store re-checks so no internal caller can
 * bypass it).
 */

import { describe, expect, it } from "vitest";
import { validateWriteProvenance } from "../src/types.js";

const PRINCIPAL =
  "spiffe://notusmi.com/session/aa579121-1a2b-4c3d-8e4f-a5b6c7d8e9f0";

describe("validateWriteProvenance", () => {
  it("passes with neither author nor offset", () => {
    expect(() => {
      validateWriteProvenance(undefined, undefined);
    }).not.toThrow();
  });

  it("passes with an author and no offset (024 behavior unchanged)", () => {
    expect(() => {
      validateWriteProvenance("human", undefined);
    }).not.toThrow();
    expect(() => {
      validateWriteProvenance(PRINCIPAL, undefined);
    }).not.toThrow();
  });

  it("passes with a session principal and an offset", () => {
    expect(() => {
      validateWriteProvenance(PRINCIPAL, 42);
    }).not.toThrow();
    expect(() => {
      validateWriteProvenance(PRINCIPAL, 0);
    }).not.toThrow();
  });

  it("throws when an offset has no author at all", () => {
    expect(() => {
      validateWriteProvenance(undefined, 42);
    }).toThrow(/session/);
  });

  it("throws when an offset rides a legacy author", () => {
    expect(() => {
      validateWriteProvenance("human", 42);
    }).toThrow(/session/);
    expect(() => {
      validateWriteProvenance("calliope", 0);
    }).toThrow(/session/);
  });

  it("names the rule in the error", () => {
    expect(() => {
      validateWriteProvenance("human", 7);
    }).toThrow(/kafka_offset requires a session-principal/);
  });
});
