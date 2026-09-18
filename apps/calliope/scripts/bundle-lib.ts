// The bundle step, as a function a test can drive: everything bundle.ts
// decides lives here, with the bundler and the error sink injected, so the
// entry script is one line that cannot hide a branch. The mutation lane
// scopes the whole diff, and a build script with no test is a script whose
// wrong option (a dropped plugin, a wrong entry) ships to the image unseen.
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
 *  line per output otherwise. */
export async function bundleCalliope(
  argv: readonly string[],
  build: BuildFn,
  stderr: ErrorSink,
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
  for (const out of result.outputs) {
    stderr.write(`bundled ${out.path} (${String(out.size)} bytes)\n`);
  }
  return 0;
}
