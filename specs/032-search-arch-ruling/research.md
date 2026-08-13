# Research: Rule the desktop search architecture

Phase 0 output. The planning context decides most points — those are recorded as
carried decisions, not re-researched (Forge override rule). One genuine unknown
remains and is closed by an in-feature spike, not by research.

## Carried decisions (planning context / master-plan Decision Log — not re-derived)

| Decision | Rationale (carried) | Alternatives (already rejected) |
| :--- | :--- | :--- |
| Local FTS = SQLite FTS5 via `bun:sqlite` | verified working live on bun 1.3.14; in-process, no service, survives `bun build --compile` | tantivy — breaks the compile target or forks the verbs out of Calliope |
| Local semantic = small int8 encoder, wasm ONNX | corpus measurement makes storage (~36 MB) and brute-force search (tens of ms) free; only generation costs | deferring the semantic arm — recommended and **reversed by Rob**; not re-openable here |
| Fusion = reciprocal-rank fusion (RRF) | fusion over one ranked list *is* that list — degraded mode is honest by construction, not a fallback hack | score normalization/interleaving — not considered; RRF is the decided mechanism |
| Remote arm = Eros (`eros_search`, bge-m3) | `calliope_documents` already indexed at 36,432 chunks, 100% embedded, with decay + engagement | a third FTS implementation (Postgres FTS per Fable Wave 1.1) — superseded, measured |
| No ANN index locally | 92,800 × 384-dim int8 ≈ 36M MACs per query — brute force is tens of ms; HNSW is machinery for a problem this corpus does not have | HNSW/IVF — rejected by measurement |
| Vector spaces never shared across the seam | local 384-dim ≠ Eros bge-m3 1024-dim; consistent with local/remote never syncing | warming the local index from Eros — impossible by construction, recorded so nobody tries |

## The one unknown — closed by spike, not research

**Question**: do wasm runtime assets survive `bun build --compile` (the sidecar's
actual build: `--target=bun-{windows,linux}-x64`)?

- **Why it matters**: the local semantic arm's decided engine is an int8 encoder
  running on a wasm ONNX runtime *inside the compiled sidecar binary*. If the wasm
  asset cannot be bundled + loaded from the single-file executable, that engine is
  unbuildable as ruled.
- **How it closes**: `apps/calliope/spikes/wasm-compile-spike/` — a minimal
  entrypoint that embeds a `.wasm` module the way the encoder runtime would, is
  compiled with the sidecar's exact flags (linux-x64 executed locally; windows-x64
  built to prove bundling), and is run: the binary must instantiate the wasm module
  and execute an exported function.
- **Decision branch (decided now, Constitution II — the spike picks the branch, not
  the engineer)**:
  - **Wasm loads** → the ruling names the int8 wasm-ONNX encoder as the local
    semantic engine (as planned).
  - **Wasm fails** → the ruling names **static embeddings** (model2vec/potion
    class, ~15–30 MB lookup tables, no inference runtime at all) as the local
    semantic engine. Plain-array lookups cannot be broken by the bundler.
- **Note on model sizes**: master-plan flags that encoder/model sizes came from
  training data, not verified against current releases — the ruling records this as
  a build-time verification item for F2, since no model is downloaded in F1.

## Edge answers the planning context is silent on (decided by this plan, provenance: Default)

- **N=0 arms** (no index yet, remote dark): the verb returns an explicit
  "no arms available" state, distinguishable from zero matches.
- **Multi-arm duplicate hits**: RRF handles this natively — a hit ranked by k arms
  accumulates k reciprocal-rank contributions; provenance lists every arm that
  ranked it.
- **Availability evaluation**: per-query, not per-session — an arm that comes back
  mid-session joins the next query with no restart.
