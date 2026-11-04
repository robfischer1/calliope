/**
 * Compile the sidecar to single-file executables (Windows + Linux).
 *
 * `bun build --compile` embeds the JS graph but not files a module reads from
 * disk at load time. @platformatic/wasm-utils (pulled in through
 * @forge/stellar-core-ts → @platformatic/kafka) does
 * `readFileSync(new URL('../dist/native.wasm', import.meta.url))` on import,
 * so a CLI-compiled sidecar died at start with ENOENT for
 * `B:\~BUN\dist\native.wasm` (calliope#26571). The plugin below rewrites that
 * one call to read an embedded copy (`with { type: "file" }`), which the
 * compiled binary resolves inside its own virtual filesystem.
 */

import type { BunPlugin } from "bun";
import * as path from "node:path";

const embedWasm: BunPlugin = {
  name: "embed-wasm-utils-native",
  setup(build) {
    build.onLoad(
      { filter: /@platformatic[\\/]wasm-utils[\\/]dist[\\/]index\.js$/ },
      async ({ path: file }) => {
        const source = await Bun.file(file).text();
        const call = "new URL('../dist/native.wasm', import.meta.url)";
        if (!source.includes(call)) {
          throw new Error(`embed-wasm: loader shape changed in ${file}`);
        }
        const wasm = path.join(path.dirname(file), "native.wasm");
        const contents =
          `import __nativeWasm from ${JSON.stringify(wasm)} with { type: "file" };\n` +
          source.replace(call, "__nativeWasm");
        return { contents, loader: "js" };
      },
    );
  },
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
    plugins: [embedWasm],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.error(`✓ ${outfile} (${target})`);
}
