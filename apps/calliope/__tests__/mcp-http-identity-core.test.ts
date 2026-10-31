import { beforeEach, describe, expect, it, vi } from "vitest";

// The identity core is loaded before the door is built, so a core that
// cannot load fails the boot (and the build lane's boot smoke) instead of
// killing the process at its first typed peer (stellar-core-ts 0.17.0,
// calliope crashloop 2026-10-04).
const core = vi.hoisted(() => ({
  reservedHeaders: vi.fn(() => ["x-forge-principal"]),
}));
vi.mock("@forge/stellar-core-ts/identitycore", () => core);

import { recordingWitness, serveDoor } from "./rest-door.js";

describe("serveCalliope — the identity core loads at boot", () => {
  beforeEach(() => {
    core.reservedHeaders.mockClear();
  });

  it("loads the core before it serves anything", async () => {
    const { rest } = await serveDoor({ witness: recordingWitness().witness });
    expect(core.reservedHeaders).toHaveBeenCalledTimes(1);
    await rest.close();
  });

  it("does not serve over a core that cannot load", async () => {
    core.reservedHeaders.mockImplementationOnce(() => {
      throw new Error(
        "ENOENT: no such file or directory, open '/app/identitycore-gen/identity-core.config.core.wasm'",
      );
    });
    await expect(
      serveDoor({ witness: recordingWitness().witness }),
    ).rejects.toThrow(/ENOENT/);
  });
});
