/**
 * Compile the sidecar to single-file executables (Windows + Linux).
 *
 * `bun build --compile` from the CLI takes no plugins, and
 * @platformatic/wasm-utils (pulled in through @forge/stellar-core-ts →
 * @platformatic/kafka) reads `../dist/native.wasm` off disk at import, so a
 * CLI-compiled sidecar died at start with ENOENT for
 * `B:\~BUN\dist\native.wasm` (calliope#26571). The core's
 * `platformaticWasmBundled` plugin swaps that import for the package's
 * inlined twin — the same swap the image bundle (bundle.ts) makes.
 * `smoke-sidecar.ts` proves the result reaches its handshake.
 */

import {
  type BundlerPlugin,
  platformaticWasmBundled,
} from "@forge/stellar-core-ts/bundle";
import * as path from "node:path";

/** The slice of `Bun.build` this script uses, declared here rather than
 *  pulling bun-types in globally (the bundle.ts convention). */
declare const Bun: {
  readonly build: (options: {
    readonly entrypoints: string[];
    readonly compile: { readonly target: string; readonly outfile: string };
    readonly plugins: BundlerPlugin[];
  }) => Promise<{ readonly success: boolean; readonly logs: unknown[] }>;
};

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "..", "src", "mcp", "sidecar.ts");

const targets = [
  ["bun-windows-x64", "dist/calliope-sidecar.exe"],
  ["bun-linux-x64", "dist/calliope-sidecar"],
] as const;

for (const [target, outfile] of targets) {
  const result = await Bun.build({
    entrypoints: [ENTRY],
    compile: { target, outfile: path.join(HERE, "..", outfile) },
    plugins: [platformaticWasmBundled],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.error(`✓ ${outfile} (${target})`);
}
