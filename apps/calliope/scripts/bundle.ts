import { bundleCalliope, type BuildFn } from "./bundle-lib.js";

declare const Bun: { readonly build: BuildFn };

process.exitCode = await bundleCalliope(
  process.argv,
  Bun.build,
  process.stderr,
);
