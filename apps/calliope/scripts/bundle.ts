// Bundle the streamable-HTTP entry + deps into ONE bun-target file, for the
// image's runtime stage (no node_modules shipped). The same `bun build
// --target=bun --minify` the Dockerfile ran inline until the core's Kafka
// client arrived: `@platformatic/kafka` reads its WebAssembly off disk
// relative to its own module, which a one-file bundle cannot carry, so the
// core ships the resolve-time swap onto the package's inlined entry and this
// script is the few lines that apply it. Run from the repo root.
//
// Declares the one Bun surface it uses rather than adding bun-types globally
// (the convention fetch-search-assets.ts set).
import {
  platformaticWasmBundled,
  type BundlerPlugin,
} from "@forge/stellar-core-ts/bundle";

interface BuildOutput {
  readonly path: string;
  readonly size: number;
}
interface BuildResult {
  readonly success: boolean;
  readonly outputs: readonly BuildOutput[];
  readonly logs: readonly unknown[];
}
declare const Bun: {
  build(options: {
    entrypoints: string[];
    outdir: string;
    naming: string;
    target: "bun";
    minify: boolean;
    plugins: BundlerPlugin[];
  }): Promise<BuildResult>;
};

const outdir = process.argv[2];
if (outdir === undefined || outdir === "") {
  process.stderr.write("usage: bun apps/calliope/scripts/bundle.ts <outdir>\n");
  process.exit(2);
}

const result = await Bun.build({
  entrypoints: ["apps/calliope/src/mcp/http.ts"],
  outdir,
  naming: "server.js",
  target: "bun",
  minify: true,
  plugins: [platformaticWasmBundled],
});
if (!result.success) {
  for (const log of result.logs) process.stderr.write(`${String(log)}\n`);
  process.exit(1);
}
for (const out of result.outputs) {
  process.stderr.write(`bundled ${out.path} (${String(out.size)} bytes)\n`);
}
