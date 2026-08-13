# Research: The search verb in Calliope

Phase 0. Two live proofs ran in this session (Constitution V — observed, not
assumed); everything else is carried from F1's ruling or decided in plan.md.

## Proof 1 — onnxruntime-web executes under Bun 1.3.14 (dev mode)

```text
session created in 352ms
inputs: [ "input_ids", "attention_mask", "token_type_ids" ] outputs: [ "last_hidden_state" ]
inference 23.1ms; output dims: [1,4,384]
PASS: onnxruntime-web wasm executed under Bun
```

- Model: `Xenova/all-MiniLM-L6-v2` `onnx/model_quantized.onnx` — **22,972,370
  bytes fetched from the current release** (the master-plan's "verify sizes at
  build time" item: closed; training-data estimate held).
- Runtime resolution under Bun picks `ort.node.min.mjs`, which loads
  `ort-wasm-simd-threaded.mjs` + `.wasm` from `ort.env.wasm.wasmPaths`; a
  file-URL directory works, and the **object form** `{ mjs, wasm }` works.

## Proof 2 — the full runtime + model execute from inside a compiled binary

`bun build --compile --target=bun-linux-x64` with all assets imported
`with { type: "file" }` (ort .mjs, ort .wasm, the 22.9 MB model):

```text
dims: [1,4,384]
PASS: ORT + model executed from inside the compiled binary
```

The F1 ruling's "embedded in the compiled sidecar" is therefore *possible*
end-to-end. plan.md Decision 4 still ships assets beside the binary (packaging
pragmatics: one loading mechanism across dev/vitest/CI/compiled; no build-time
hard dependency on a 23 MB download) — recorded as a divergence, not a blocker.

## Local endpoint reconnaissance

`http://localhost:11434` (this host, rob02) is live: ollama 0.32.9 serving
`bge-m3:latest` — **1024-dim, the Eros space**. Confirms plan.md Decision 5's
refusal rule matters: the accelerator must serve the same nominal 384-dim model
(e.g. `all-minilm`), and bge-m3 must be refused loudly rather than silently
poisoning the local space (the ruling's "vector spaces never cross the seam").

## Carried decisions (not re-derived)

FTS5 via `bun:sqlite` (verified previously, and the sidecar compiles it — B2's
`031-sidecar-mcp` already ships `bun:sqlite`-free sidecar; FTS5 is compiled into
bun's SQLite); RRF as fusion; no ANN; paragraph-count measurement (~92,800);
the F1 hit/envelope contract.

## Tokenizer decision

Hand-rolled WordPiece (BERT-uncased rules: NFC → lowercase + strip accents →
punctuation isolation → whitespace split → longest-match WordPiece with `##`
continuations, `[CLS]`/`[SEP]` framing, 256-token truncation) reading the vocab
out of the fetched `tokenizer.json`. Rejected: `@huggingface/transformers`
(pulls its own ORT + sharp + megabytes of loader machinery for one function —
violates the dependency guideline by orders of magnitude).
