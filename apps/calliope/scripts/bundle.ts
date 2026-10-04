// The image's bundle step — see bundle-lib.ts for what it does and why it
// exists. This file is deliberately one statement: the decisions live in
// the lib where a test reaches them, and `Bun.build` is declared here (the
// one Bun surface used) rather than pulling bun-types in globally, the
// convention fetch-search-assets.ts set.
import { bundleCalliope, type BuildFn } from "./bundle-lib.js";

declare const Bun: { readonly build: BuildFn };

process.exitCode = await bundleCalliope(
  process.argv,
  Bun.build,
  process.stderr,
);
