/**
 * Deterministic generator for `add.wasm` — the smallest real wasm module with an
 * exported function: `add(i32, i32) -> i32`. Kept as a generator (not a checked-in
 * binary) so the asset's provenance is inspectable. Run: `bun run make-wasm.ts`.
 */

// Hand-assembled wasm binary: magic + version, type/function/export/code sections.
const bytes = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d, // \0asm
  0x01,
  0x00,
  0x00,
  0x00, // version 1
  // type section: one type, (i32, i32) -> i32
  0x01,
  0x07,
  0x01,
  0x60,
  0x02,
  0x7f,
  0x7f,
  0x01,
  0x7f,
  // function section: one function of type 0
  0x03,
  0x02,
  0x01,
  0x00,
  // export section: "add" -> func 0
  0x07,
  0x07,
  0x01,
  0x03,
  0x61,
  0x64,
  0x64,
  0x00,
  0x00,
  // code section: local.get 0; local.get 1; i32.add; end
  0x0a,
  0x09,
  0x01,
  0x07,
  0x00,
  0x20,
  0x00,
  0x20,
  0x01,
  0x6a,
  0x0b,
]);

await Bun.write(new URL("./add.wasm", import.meta.url), bytes);
console.error(`wrote add.wasm (${bytes.length} bytes)`);
