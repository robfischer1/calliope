/**
 * F1 spike — does a `.wasm` asset survive `bun build --compile`?
 *
 * Replicates the load path a wasm ONNX runtime needs inside the compiled
 * sidecar: a `.wasm` file imported as an embedded asset, read back at runtime
 * from inside the single-file binary, instantiated, and executed. The build
 * flags mirror `build:sidecar` in apps/calliope/package.json exactly.
 *
 * PASS: the compiled binary prints add(19, 23) = 42.
 * FAIL: the import, embed, read, instantiate, or call step breaks — which
 * selects the static-embeddings branch (see specs/032-search-arch-ruling).
 */
import wasmPath from "./add.wasm" with { type: "file" };

const bytes = await Bun.file(wasmPath).arrayBuffer();
const { instance } = await WebAssembly.instantiate(bytes);
const add = instance.exports.add as (a: number, b: number) => number;

const got = add(19, 23);
console.log(`add(19, 23) = ${got}`);
if (got !== 42) {
  console.error("FAIL: embedded wasm executed but returned a wrong result");
  process.exit(1);
}
console.log(
  "PASS: embedded wasm instantiated and executed inside the compiled binary",
);
