/**
 * F1 (024) — the widened AuthoredBy type family and its runtime guard.
 *
 * The union widens from "human" | "calliope" to also admit a SPIFFE session
 * principal (spiffe://{td}/session/{uuid}). The type's home moves to types.ts
 * (the import root); urania-client.ts re-exports it so existing import paths
 * keep compiling — both routes are asserted here.
 */

import { describe, expect, it } from "vitest";
import {
  SESSION_PRINCIPAL_RE,
  isAuthoredBy,
  type AuthoredBy,
  type BlockOp,
} from "../src/types.js";
import { isAuthoredBy as reExportedGuard } from "../src/urania-client.js";
import type { AuthoredBy as ReExportedAuthoredBy } from "../src/urania-client.js";

const PRINCIPAL =
  "spiffe://notusmi.com/session/aa579121-1a2b-4c3d-8e4f-a5b6c7d8e9f0";

describe("isAuthoredBy — the runtime guard", () => {
  it("accepts both legacy literals", () => {
    expect(isAuthoredBy("human")).toBe(true);
    expect(isAuthoredBy("calliope")).toBe(true);
  });

  it("accepts a UUID-tailed session principal", () => {
    expect(isAuthoredBy(PRINCIPAL)).toBe(true);
  });

  it("rejects arbitrary strings", () => {
    expect(isAuthoredBy("gandalf")).toBe(false);
    expect(isAuthoredBy("")).toBe(false);
  });

  it("rejects a workload (non-session) SPIFFE id", () => {
    expect(isAuthoredBy("spiffe://notusmi.com/workload/calliope")).toBe(false);
  });

  it("rejects a session principal with a non-UUID tail", () => {
    expect(isAuthoredBy("spiffe://notusmi.com/session/not-a-uuid")).toBe(false);
    expect(isAuthoredBy("spiffe://notusmi.com/session/")).toBe(false);
  });

  it("rejects uppercase-hex UUID tails (canonical form is lowercase)", () => {
    expect(
      isAuthoredBy(
        "spiffe://notusmi.com/session/AA579121-1A2B-4C3D-8E4F-A5B6C7D8E9F0",
      ),
    ).toBe(false);
  });

  it("rejects trailing garbage after the UUID", () => {
    expect(isAuthoredBy(`${PRINCIPAL}/extra`)).toBe(false);
    expect(isAuthoredBy(`${PRINCIPAL} `)).toBe(false);
  });

  it("narrows to AuthoredBy (type-level: guarded value assigns)", () => {
    const v: string = PRINCIPAL;
    if (isAuthoredBy(v)) {
      const a: AuthoredBy = v; // compile-time proof of narrowing
      expect(a).toBe(PRINCIPAL);
    } else {
      expect.unreachable("guard rejected a valid principal");
    }
  });
});

describe("SESSION_PRINCIPAL_RE", () => {
  it("matches exactly the session-principal family", () => {
    expect(SESSION_PRINCIPAL_RE.test(PRINCIPAL)).toBe(true);
    expect(SESSION_PRINCIPAL_RE.test("human")).toBe(false);
  });
});

describe("the widened union (compile-time contracts)", () => {
  it("legacy literals still inhabit AuthoredBy", () => {
    const human: AuthoredBy = "human";
    const calliope: AuthoredBy = "calliope";
    expect([human, calliope]).toEqual(["human", "calliope"]);
  });

  it("a template-literal principal inhabits AuthoredBy", () => {
    const p: AuthoredBy =
      "spiffe://notusmi.com/session/aa579121-1a2b-4c3d-8e4f-a5b6c7d8e9f0";
    expect(p).toBe(PRINCIPAL);
  });

  it("BlockOp.authored_by admits a principal (the wire is as wide as the row)", () => {
    const op: BlockOp = {
      block_id: "b1",
      op_type: "add",
      content_delta: "text",
      order_key: "a0",
      timestamp: "2026-08-13T00:00:00.000Z",
      authored_by:
        "spiffe://notusmi.com/session/aa579121-1a2b-4c3d-8e4f-a5b6c7d8e9f0",
      node_id: "n1",
    };
    expect(op.authored_by).toBe(PRINCIPAL);
  });
});

describe("urania-client re-export (existing import paths keep working)", () => {
  it("re-exports the same guard", () => {
    expect(reExportedGuard).toBe(isAuthoredBy);
  });

  it("re-exports the same type (compile-time)", () => {
    const a: ReExportedAuthoredBy = "human";
    const b: ReExportedAuthoredBy =
      "spiffe://notusmi.com/session/aa579121-1a2b-4c3d-8e4f-a5b6c7d8e9f0";
    expect([a, b]).toEqual(["human", PRINCIPAL]);
  });
});
