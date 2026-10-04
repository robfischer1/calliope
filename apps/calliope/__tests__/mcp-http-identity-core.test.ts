import { beforeEach, describe, expect, it, vi } from "vitest";

// The identity core is loaded when the server is built, so a core that
// cannot load fails the boot (and the build lane's boot smoke) instead of
// killing the process at its first mTLS peer (stellar-core-ts 0.17.0,
// calliope crashloop 2026-10-04).
const core = vi.hoisted(() => ({
  reservedHeaders: vi.fn(() => ["x-forge-principal"]),
}));
vi.mock("@forge/stellar-core-ts/identitycore", () => core);

import { createCalliopeHttpServer } from "../src/mcp/http.js";

describe("createCalliopeHttpServer — the identity core loads at boot", () => {
  beforeEach(() => {
    core.reservedHeaders.mockClear();
  });

  it("loads the core before it serves anything", () => {
    const server = createCalliopeHttpServer("fixture");
    expect(core.reservedHeaders).toHaveBeenCalledTimes(1);
    server.close();
  });

  it("does not build a server over a core that cannot load", () => {
    core.reservedHeaders.mockImplementationOnce(() => {
      throw new Error(
        "ENOENT: no such file or directory, open '/app/identitycore-gen/identity-core.config.core.wasm'",
      );
    });
    expect(() => createCalliopeHttpServer("fixture")).toThrow(/ENOENT/);
  });
});
