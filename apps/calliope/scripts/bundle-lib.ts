// The bundle step, as a function a test can drive: everything bundle.ts
// decides lives here, with the bundler and the error sink injected, so the
// entry script is one line that cannot hide a branch. The mutation lane
// scopes the whole diff, and a build script with no test is a script whose
// wrong option (a dropped plugin, a wrong entry) ships to the image unseen.
import { cpSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { BundlerPlugin } from "@forge/stellar-core-ts/bundle";
import { platformaticWasmBundled } from "@forge/stellar-core-ts/bundle";

/** The slice of `Bun.build` this step uses — structural, so a test hands
 *  in a double and the script hands in the real one. */
export interface BuildOptions {
  readonly entrypoints: string[];
  readonly outdir: string;
  readonly naming: string;
  readonly target: "bun";
  readonly minify: boolean;
  readonly plugins: BundlerPlugin[];
}
export interface BuildOutput {
  readonly path: string;
  readonly size: number;
}
export interface BuildResult {
  readonly success: boolean;
  readonly outputs: readonly BuildOutput[];
  readonly logs: readonly unknown[];
}
export type BuildFn = (options: BuildOptions) => Promise<BuildResult>;

/** Where diagnostics go: stderr, never stdout. */
export interface ErrorSink {
  write(chunk: string): unknown;
}

/** The output directory from argv, or `undefined` when none was given.
 *  An absent entry is already `undefined`; only the empty string needs
 *  folding, so that is the one comparison — a second, for `undefined`,
 *  would be a branch no test could tell apart from its absence. */
export function outdirFrom(argv: readonly string[]): string | undefined {
  const raw = argv[2];
  return raw === "" ? undefined : raw;
}

/** What the bundle leaves beside server.js, and what the image copies. */
export const CORE_DIR = "identitycore-gen";

/** Where the identity core's generated wasm lives in the installed package.
 *  Resolved the way the bundler resolves the core (the `bun` export
 *  condition), because the core reads it relative to its own module: in the
 *  bundle that is server.js, so the files must sit beside it. Without it the
 *  peer-typing witness (stellar-core-ts >= 0.17) cannot load its core — and
 *  calliope crashlooped on ENOENT /app/identitycore-gen/… (2026-10-04). */
export function identityCoreSource(): string {
  const entry = createRequire(import.meta.url).resolve(
    "@forge/stellar-core-ts/identitycore",
  );
  return join(dirname(entry), CORE_DIR);
}

/** Copy the core's wasm next to the bundle. Throws when the source is
 *  missing, so a package that moved it fails the build, not the pod. */
export function copyIdentityCore(outdir: string): void {
  cpSync(identityCoreSource(), join(outdir, CORE_DIR), { recursive: true });
}

/** The one bundle this star builds: its entry, one minified bun-target
 *  file named server.js, and the core's wasm swap — `@platformatic/kafka`
 *  reads its WebAssembly off disk relative to its own module, which a
 *  one-file bundle cannot carry. */
export function bundleOptions(outdir: string): BuildOptions {
  return {
    entrypoints: ["apps/calliope/src/mcp/http.ts"],
    outdir,
    naming: "server.js",
    target: "bun",
    minify: true,
    plugins: [platformaticWasmBundled],
  };
}

/** Run the bundle step. Answers the process exit code: 2 for a missing
 *  outdir, 1 for a failed build (its logs written to `stderr`), 0 with one
 *  line per output otherwise. A successful build is followed by `copyCore`
 *  (the identity core's wasm, beside the bundle); a throw from it fails the
 *  step. */
export async function bundleCalliope(
  argv: readonly string[],
  build: BuildFn,
  stderr: ErrorSink,
  copyCore: (outdir: string) => void,
): Promise<number> {
  const outdir = outdirFrom(argv);
  if (outdir === undefined) {
    stderr.write("usage: bun apps/calliope/scripts/bundle.ts <outdir>\n");
    return 2;
  }
  const result = await build(bundleOptions(outdir));
  if (!result.success) {
    for (const log of result.logs) stderr.write(`${String(log)}\n`);
    return 1;
  }
  copyCore(outdir);
  for (const out of result.outputs) {
    stderr.write(`bundled ${out.path} (${String(out.size)} bytes)\n`);
  }
  return 0;
}
