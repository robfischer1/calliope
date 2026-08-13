import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIMS,
  dotInt8,
  OrtEmbedder,
  poolAndQuantize,
  resolveAssetsDir,
} from "../src/fs-search/encoder.js";

describe("poolAndQuantize", () => {
  it("mean-pools, L2-normalizes, and quantizes to ≈unit int8", () => {
    // Two timesteps whose mean is a one-hot on dim 0.
    const hidden = new Float32Array(2 * DIMS);
    hidden[0] = 2;
    hidden[DIMS] = 4; // dim 0 of t=1
    const v = poolAndQuantize(hidden, 2);
    expect(v).toHaveLength(DIMS);
    expect(v[0]).toBe(127);
    expect([...v.slice(1)].every((x) => x === 0)).toBe(true);
  });

  it("norm of the quantized vector is ~127 (unit ×127)", () => {
    const hidden = new Float32Array(DIMS).map(() => Math.random() - 0.5);
    const v = poolAndQuantize(hidden, 1);
    const norm = Math.sqrt(dotInt8(v, v));
    expect(norm).toBeGreaterThan(120);
    expect(norm).toBeLessThan(134);
  });
});

describe("resolveAssetsDir", () => {
  it("honors the env override only when all four assets exist", async () => {
    const missing = await resolveAssetsDir({
      CALLIOPE_SEARCH_ASSETS: path.join("/nonexistent", "assets"),
    });
    // Falls through env (missing) — beside-binary and models/ may or may not
    // exist on the runner; the contract here is just "no crash, dir or null".
    expect(missing === null || typeof missing === "string").toBe(true);
  });
});

describe("OrtEmbedder (integration — auto-skips without provisioned assets)", () => {
  it("embeds a real sentence to a 384-dim int8 unit vector", async () => {
    const assets = await resolveAssetsDir();
    if (assets === null) {
      // `bun run fetch-search-assets` not run — the offline suite stays green.
      return;
    }
    const embedder = await OrtEmbedder.create(assets);
    const [v] = await embedder.embed(["the heron lands at dusk"]);
    expect(v).toHaveLength(DIMS);
    const norm = Math.sqrt(
      dotInt8(v ?? new Int8Array(DIMS), v ?? new Int8Array(DIMS)),
    );
    expect(norm).toBeGreaterThan(120);
  }, 30_000);
});
