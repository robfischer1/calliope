// ── the image's bundle step, driven with a bundler double ───────────────────

import { describe, expect, it } from "vitest";
import { platformaticWasmBundled } from "@forge/stellar-core-ts/bundle";
import {
  bundleCalliope,
  bundleOptions,
  outdirFrom,
  type BuildFn,
  type BuildOptions,
} from "../scripts/bundle-lib.js";

function sink(): { write: (chunk: string) => boolean; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(chunk) {
      lines.push(chunk);
      return true;
    },
  };
}

describe("outdirFrom", () => {
  it("is the third argv entry", () => {
    expect(outdirFrom(["bun", "scripts/bundle.ts", "/deploy"])).toBe("/deploy");
  });

  it("is undefined when the entry is missing or empty", () => {
    expect(outdirFrom(["bun", "scripts/bundle.ts"])).toBeUndefined();
    expect(outdirFrom(["bun", "scripts/bundle.ts", ""])).toBeUndefined();
  });
});

describe("bundleOptions", () => {
  it("bundles the HTTP entry into one minified bun-target server.js, with the core's wasm swap", () => {
    expect(bundleOptions("/deploy")).toEqual({
      entrypoints: ["apps/calliope/src/mcp/http.ts"],
      outdir: "/deploy",
      naming: "server.js",
      target: "bun",
      minify: true,
      plugins: [platformaticWasmBundled],
    });
  });
});

describe("bundleCalliope", () => {
  it("refuses with the usage line and exit 2 when no outdir is given, building nothing", async () => {
    const errors = sink();
    let built = 0;
    const build: BuildFn = () => {
      built++;
      return Promise.resolve({ success: true, outputs: [], logs: [] });
    };
    expect(
      await bundleCalliope(["bun", "scripts/bundle.ts"], build, errors),
    ).toBe(2);
    expect(
      await bundleCalliope(["bun", "scripts/bundle.ts", ""], build, errors),
    ).toBe(2);
    expect(errors.lines).toEqual([
      "usage: bun apps/calliope/scripts/bundle.ts <outdir>\n",
      "usage: bun apps/calliope/scripts/bundle.ts <outdir>\n",
    ]);
    expect(built).toBe(0);
  });

  it("builds with exactly the declared options and reports each output, exit 0", async () => {
    const errors = sink();
    const seen: BuildOptions[] = [];
    const build: BuildFn = (options) => {
      seen.push(options);
      return Promise.resolve({
        success: true,
        outputs: [{ path: "/deploy/server.js", size: 2547411 }],
        logs: [],
      });
    };
    expect(
      await bundleCalliope(
        ["bun", "scripts/bundle.ts", "/deploy"],
        build,
        errors,
      ),
    ).toBe(0);
    expect(seen).toEqual([bundleOptions("/deploy")]);
    expect(errors.lines).toEqual([
      "bundled /deploy/server.js (2547411 bytes)\n",
    ]);
  });

  it("writes every build log and exits 1 when the build fails", async () => {
    const errors = sink();
    const build: BuildFn = () =>
      Promise.resolve({
        success: false,
        outputs: [],
        logs: ["error: cannot resolve x", { toString: (): string => "second" }],
      });
    expect(
      await bundleCalliope(
        ["bun", "scripts/bundle.ts", "/deploy"],
        build,
        errors,
      ),
    ).toBe(1);
    expect(errors.lines).toEqual(["error: cannot resolve x\n", "second\n"]);
  });
});
