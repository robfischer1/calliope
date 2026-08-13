# wasm-compile-spike — observed result

**Question** (Findability F1, the one unverified constraint): do `.wasm` assets
survive `bun build --compile` with the sidecar's targets?

**Answer: YES** — verified 2026-08-13, bun 1.3.14.

## What ran

```sh
bun run make-wasm.ts     # writes add.wasm (41 bytes, hand-assembled, exported add(i32,i32)->i32)
bun build --compile --target=bun-linux-x64 spike.ts --outfile dist/spike
./dist/spike
bun build --compile --target=bun-windows-x64 spike.ts --outfile dist/spike-win
```

## Observed output (verbatim)

```text
   [4ms]  bundle  2 modules
 [299ms] compile  dist/spike
add(19, 23) = 42
PASS: embedded wasm instantiated and executed inside the compiled binary

   [3ms]  bundle  2 modules
 [526ms] compile  dist/spike-win.exe bun-windows-x64-v1.3.14
```

- linux-x64: compiled binary executed here; the embedded `.wasm` was read back via
  `Bun.file(path)` on the `with { type: "file" }` import, instantiated with
  `WebAssembly.instantiate`, and its exported function returned the right value.
- windows-x64: same bundle compiled without error (build-only proof; execution not
  possible on this host — the bundling mechanism is identical, per the spec's
  recorded assumption).

## Consequence (the decided branch)

The local semantic arm is the **int8 wasm-ONNX encoder**, as planned. The
static-embeddings fallback (model2vec/potion class) is NOT selected — it remains
recorded in `docs/search-architecture.md` as the contingency if a real ONNX
runtime's asset shape diverges from this proof at F2 build time.
