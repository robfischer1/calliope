import { describe, expect, it } from "vitest";
import { backendKind } from "../src/mcp/backend.js";

describe("backendKind — backend selection from env", () => {
  it("returns 'fixture' when CALLIOPE_MCP_BACKEND=fixture", () => {
    expect(backendKind({ CALLIOPE_MCP_BACKEND: "fixture" })).toBe("fixture");
  });

  it("returns 'hades' when CALLIOPE_MCP_BACKEND=hades", () => {
    expect(backendKind({ CALLIOPE_MCP_BACKEND: "hades" })).toBe("hades");
  });

  it("returns 'urania' when CALLIOPE_MCP_BACKEND=urania (explicit)", () => {
    expect(backendKind({ CALLIOPE_MCP_BACKEND: "urania" })).toBe("urania");
  });

  it("auto-selects 'hades' when CALLIOPE_WRITE_VIA_HADES=1", () => {
    expect(backendKind({ CALLIOPE_WRITE_VIA_HADES: "1" })).toBe("hades");
  });

  it("auto-selects 'hades' when CALLIOPE_WRITE_VIA_HADES=true", () => {
    expect(backendKind({ CALLIOPE_WRITE_VIA_HADES: "true" })).toBe("hades");
  });

  it("auto-selects 'hades' when CHARON_URL is set (non-empty)", () => {
    expect(backendKind({ CHARON_URL: "http://charon:8300" })).toBe("hades");
  });

  it("defaults to 'urania' when no relevant env vars are set", () => {
    expect(backendKind({})).toBe("urania");
  });

  it("CALLIOPE_MCP_BACKEND=fixture takes priority over CALLIOPE_WRITE_VIA_HADES", () => {
    expect(
      backendKind({
        CALLIOPE_MCP_BACKEND: "fixture",
        CALLIOPE_WRITE_VIA_HADES: "1",
      }),
    ).toBe("fixture");
  });

  it("CALLIOPE_MCP_BACKEND=urania takes priority over CALLIOPE_WRITE_VIA_HADES", () => {
    expect(
      backendKind({
        CALLIOPE_MCP_BACKEND: "urania",
        CALLIOPE_WRITE_VIA_HADES: "1",
      }),
    ).toBe("urania");
  });
});
