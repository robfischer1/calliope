# Implementation Plan: The search verb in Calliope

**Branch**: `033-search-verb` | **Date**: 2026-08-13 | **Spec**: [spec.md](./spec.md)

**Input**: spec.md + the Findability master-plan F2 planning context (authoritative,
reconciled) + `docs/search-architecture.md` (the F1 ruling — binding).

## Summary

`search(query, scope)` lands as a body-verb sibling: on the fs backend the sidecar
indexes the bound root into `<root>/.grace/search.sqlite` — an FTS5 table and a
384-dim int8 vector table at the *paragraph* grain (index grain ≠ body grain; the
body's one-section-per-file derivation is untouched) — and fuses the FTS arm and the
semantic arm with RRF into the F1-ruled envelope. Incremental freshness rides
content-hash identity: an edit produces new paragraph hashes, and **only new hashes
are embedded** — one forward pass per edited block, structurally. The encoder is
the ruled int8 MiniLM (384-dim) on onnxruntime-web's wasm backend, **proven live
under Bun 1.3.14 in this session** (23 ms inference; and the full runtime + model
byte-embed proof passed — see research.md). A remote embedding endpoint, when
configured, accelerates bulk generation; its absence or death never darkens
anything the local encoder can serve, and every degraded state is named in the
envelope.

## Technical Context

**Language/Version**: TypeScript on Bun 1.3.14; `bun:sqlite` (FTS5 verified live)

**Primary Dependencies**: `onnxruntime-web` (NEW — the wasm ONNX runtime the ruling
names; proven under Bun this session). No other new runtime deps: the WordPiece
tokenizer is hand-rolled (~150 lines) from the model's `tokenizer.json` — a
tokenizer dependency (transformers.js) would be thousands of times its 20-line
guideline weight for one function.

**Storage**: `<root>/.grace/search.sqlite` — `files` (path, mtime, size),
`blocks` (path, ord, hash, text), `vectors` (hash, int8[384] blob, model),
`fts` (FTS5, external-content on blocks). `.grace/` is already dot-skipped by
every walk, so the index never indexes itself.

**Testing**: vitest; all index/fusion/degradation tests run offline with a
`FakeEmbedder` (deterministic hash-derived vectors); the real-encoder integration
test auto-skips when assets are not provisioned (CI-safe).

**Target Platform**: the sidecar (dev `bun run`, compiled `build:sidecar`); encoder
assets resolve from `CALLIOPE_SEARCH_ASSETS` > `<binary dir>/search-assets/` >
`apps/calliope/models/` (dev), fetched by `scripts/fetch-search-assets.ts`.

**Project Type**: single app (`apps/calliope`)

**Performance Goals**: query p95 < 100 ms on the reference corpus (F14 asserts;
this design must not preclude it): FTS5 ~ms; semantic = 1 query forward pass
(~23 ms measured) + brute-force int8 dot over ≤ ~92.8k × 384 (~36M MACs, typed-array
loop) — no ANN, by ruling.

**Constraints**: F1's prohibitions verbatim (no ANN; no second FTS on the remote
store; nothing breaking `bun build --compile`; vector spaces never cross the seam);
the body grain is untouched (index only); the verb is read-only on bodies.

**Scale/Scope**: 4,524 files / ~92,800 paragraph blocks / ~36 MB vectors resident.

## Constitution Check

*GATE: passed (initial); re-checked after Phase 1: passed.*

- **I**: every point below is decided (F1 ruling / planning context / this plan
  with provenance) or listed in Open & risk. No judgment remainder.
- **II**: deferrals terminate here — scope vocabulary, storage home, coalescing
  policy, encoder asset resolution are all decided below with provenance.
- **III**: the verb, envelope, wire dispatch, and store schema are written by shape
  (contracts/).
- **IV**: every task in tasks.md carries a falsifiable acceptance; SC-003's
  one-forward-pass claim is asserted by a counting-embedder test.
- **V**: quickstart.md defines the observable checks; the completion report cites
  observed output.

## Project Structure

### Documentation (this feature)

```text
specs/033-search-verb/
├── plan.md
├── research.md          # ORT-under-Bun + embed proofs (observed), decisions
├── data-model.md        # index schema + hit/envelope (F1 shapes carried)
├── quickstart.md
├── contracts/
│   └── search-verb.md   # verb signature, wire dispatch, envelope, store DDL
└── tasks.md
```

### Source Code (repository root)

```text
apps/calliope/
├── src/fs-search/
│   ├── chunker.ts        # paragraph split + content hashes (the index grain)
│   ├── tokenizer.ts      # WordPiece over tokenizer.json (hand-rolled)
│   ├── encoder.ts        # ORT wasm session, asset resolution, embed()
│   ├── remote-embed.ts   # optional bulk accelerator (env-configured endpoint)
│   ├── store.ts          # search.sqlite: files/blocks/vectors/fts + snippet
│   ├── fusion.ts         # RRF (k=60), provenance accumulation
│   └── index.ts          # LocalSearchIndex: scan, watch, coalesce, queue, search
├── src/fs-client.ts      # + optional onWrite hook (index only — grain unchanged)
├── src/mcp/server.ts     # + search registerTool (provider-injected)
├── src/mcp/sidecar.ts    # + "search" dispatch case; index construction at boot
├── scripts/fetch-search-assets.ts
└── package.json          # + onnxruntime-web; + fetch script; build:sidecar copies assets
```

**Structure Decision**: a self-contained `src/fs-search/` module keeps every file
under the 400-line rule and the seam clean: `server.ts` takes an optional
`SearchProvider`; the sidecar constructs `LocalSearchIndex` and passes it to both
its `/body` dispatch and its MCP server. Backends without a provider answer the
verb honestly (`armsQueried: []`, `armsDark: [...]`) until F4 routes them.

## Decisions (binding, provenance-tagged)

1. **Index grain = paragraph, keyed by content hash** [Default — the master-plan's
   own measurement counts "paragraph-shaped blocks"; the fs body grain (one section
   per file) is explicitly not the index grain]. `blocks(path, ord, hash)` +
   `vectors(hash)`: an edit that changes one paragraph creates one new hash → one
   forward pass. SC-003 becomes a structural property, asserted by test.
2. **The sidecar hosts its own freshness** [Default; divergence noted]: `fs.watch`
  (recursive) on the bound root with per-path debounce (250 ms) and a coalescing
   work queue (footgun #4); watcher construction failure → periodic mtime sweep
   (30 s) — the same fallback pattern Grace's shell already uses for UNC roots.
   Boot catch-up: (path, mtime, size) diff against `files`. The master-plan's
   Consumes row names "the fs watcher" (Grace's, in the Tauri shell) — that one
   feeds the UI across a process boundary and cannot feed this index; the sidecar
   watching its own root is the same mechanism in the right process. Additionally
   `FsBodyClient` gains an optional `onWrite` callback so sidecar-authored writes
   index immediately without a watcher round-trip (the fs-client Touches row,
   index only).
3. **Encoder = int8 MiniLM-class 384-dim on onnxruntime-web wasm** [F1 ruling;
   verified this session: session 352 ms, inference 23 ms, dims [1,·,384]; the
   current release's quantized model is 22.9 MB]. Mean-pool over attention mask,
   L2-normalize, quantize ×127 to int8. Query embedding always local.
4. **Assets ship beside the binary, not byte-embedded** [Default; DIVERGENCE from
   the ruling's word "embedded", surfaced in Open & risk]: resolution order
   `CALLIOPE_SEARCH_ASSETS` > `<binary dir>/search-assets/` > `apps/calliope/models/`.
   The byte-embed route was proven live (research.md) so the ruling's *constraint*
   stands closed; beside-binary is chosen so dev, vitest, CI, and compiled modes
   share one loading mechanism and no build step hard-depends on a 23 MB download.
5. **Remote endpoint = optional bulk accelerator only** [Default, reconciling the
   Consumes row with Rob's ships-in-v1 reversal]: `CALLIOPE_EMBED_URL` +
   `CALLIOPE_EMBED_MODEL` (ollama `/api/embed` shape — bge-m3 is live on this host
   but is 1024-dim and therefore REFUSED; the endpoint must serve the same nominal
   384-dim model, enforced at first response). Endpoint down mid-backfill → the
   local encoder continues; no endpoint and no local assets → semantic dark and
   the envelope says so (the Scope acceptance's FTS-only state).
6. **Fusion = RRF with k=60** [F1 ruling names RRF; 60 is the literature default —
   Default provenance], top-128 per arm before fusion, k=20 results out (caller
   may narrow). Snippets: FTS hits use FTS5 `snippet()` with ``/``
   highlight markers (never legal prose); semantic-only hits return the block's
   head (~200 chars) unmarked.
7. **Scope = root-relative subtree prefix** [spec Assumption, Default]: `scope`
   absent/"" = whole root; otherwise hits restrict to paths under the prefix.
8. **Encoder init is lazy-async at boot; a query arriving before ready degrades
   honestly** (semantic in `armsDark`) rather than blocking the boot handshake
   [Default — the sidecar's one-stdout-line boot contract must not wait 350 ms].

## Reconcile summary

- **Verbatim from the planning context**: the three Scope acceptances (ranked hits
  w/ snippets; endpoint-down → FTS-only + says so; one edited block → one
  re-embed); the hit slice (id, snippet, score, arm provenance); Touches
  (server.ts, fs-client.ts index-only, sidecar.ts); no-ANN; FTS5; semantic in v1
  [Rob]; the F1 envelope contract.
- **Generated where the context is silent**: index grain/schema, watcher locus,
  coalescing policy, asset packaging, accelerator config, RRF constant, scope
  vocabulary, snippet markers (each tagged above).
- **Divergences surfaced to Open & risk**: assets beside-binary vs the ruling's
  "embedded"; the index's watcher lives in the sidecar, not Grace's shell.

## Open & risk

- **Divergence (ruling wording)**: encoder assets ride beside the compiled binary
  instead of inside it. The embedding mechanism itself was proven (research.md),
  so this is packaging pragmatics, not capability; revisit when B1's
  auto-updater/packaging features land.
- **Divergence (watcher locus)**: the Consumes row's "existing fs watcher" is
  Grace-side; the index freshness runs sidecar-side (Decision 2). Same mechanism,
  right process; Grace's watcher remains the UI's.
- `fs.watch` recursive reliability on exotic roots (UNC/9P) — mitigated by the
  sweep fallback, same as Grace.
- First-run bulk embed locally is minutes-scale in the background (~92.8k blocks ×
  ~20-40 ms); the accelerator (Decision 5) collapses it when configured. Semantic
  is honestly partial until caught up (armsDark reports nothing false; coverage
  accounting beyond the binary envelope is a recorded follow-up for F3's UI).
- Model licence/size drift: the fetch script pins the exact quantized model URL +
  sha256; sizes verified against the current release this session (22.9 MB).

## Complexity Tracking

No constitution violations — table intentionally empty.
