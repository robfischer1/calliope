# Implementation Plan: Rule the desktop search architecture

**Branch**: `032-search-arch-ruling` | **Date**: 2026-08-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/032-search-arch-ruling/spec.md` + the
Findability master-plan F1 planning context (authoritative substrate, reconciled — not
regenerated).

## Summary

Produce the binding architecture ruling for desktop search — `docs/search-architecture.md`
— naming the engines (SQLite FTS5 full-text; small int8 encoder via wasm ONNX for the
local semantic arm; Eros/bge-m3 as the remote arm), the fusion (reciprocal-rank fusion,
defined so N=1 degrades honestly by construction), the degradation contract (fuse what is
available, name what is dark), and the inherited constraints (no local ANN index, no
second FTS against the remote store, nothing that breaks `bun build --compile`). One
spike closes the single unverified constraint: whether wasm runtime assets survive
`bun build --compile` in the sidecar; if they do not, static embeddings
(model2vec/potion class) are the recorded fallback.

## Technical Context

**Language/Version**: TypeScript on Bun 1.3.14 (verified live in this tree)

**Primary Dependencies**: `bun:sqlite` (FTS5 verified working, bun 1.3.14); wasm ONNX
runtime (spike subject — candidate for the local encoder); no new runtime deps land in
this feature (ruling + spike only)

**Storage**: N/A for the ruling; the ruled index is SQLite (FTS5 + a 384-dim int8
vector table) — implemented in F2, not here

**Testing**: vitest (`bun run test`); the spike is a build-and-execute check, not a
unit test

**Target Platform**: the compiled sidecar — `bun build --compile
--target=bun-{windows,linux}-x64` (verbatim `build:sidecar` script in
`apps/calliope/package.json`); spike executes the linux-x64 binary locally, the
windows-x64 target inherits the bundling result (spec Assumption)

**Project Type**: single app (`apps/calliope`), MCP sidecar

**Performance Goals**: inherited for the ruling's constraint table: brute-force cosine
over ~92,800 blocks × 384-dim int8 ≈ 36M MACs, tens of ms — measured in the
master-plan; restated as the reason no ANN index is permitted

**Constraints**: decided upstream, carried verbatim: search is a Calliope verb (not
Grace-local); the pg arm is Eros (never a third FTS); no ANN locally; no Rust/tantivy
(breaks the compile target); local 384-dim and Eros bge-m3 1024-dim are different
vector spaces — never share vectors across the seam

**Scale/Scope**: corpus 4,524 markdown files · 28.8 MB · ~92,800 paragraph blocks
(~75 tokens each) → ~36 MB resident at 384-dim int8

## Constitution Check

*GATE: passed (initial) — re-checked after Phase 1: passed.*

- **I. Spec-Is-Law**: every point below is decided (planning context / master-plan
  Decision Log) or `[OPEN]` (exactly one: the wasm spike result, closed by
  experiment inside this feature). No "use judgment" remainder.
- **II. Deferral-Terminates**: the encoder fallback is decided NOW conditional on the
  spike result (wasm works → int8 ONNX encoder; wasm fails → static embeddings,
  model2vec/potion class). The executor inherits a branch, not discretion.
- **III. Contracts-Named**: the hit shape and degradation contract are written by
  shape in `contracts/search-hit.md` and `data-model.md`.
- **IV. Conformance-Checkable**: the ruling's acceptance is enumerated in
  quickstart.md (read-back checks + the spike's executable proof).
- **V. Verify-Before-Done**: the spike runs the compiled binary and reports observed
  output; the ruling records the observed result, not the expectation.

## Project Structure

### Documentation (this feature)

```text
specs/032-search-arch-ruling/
├── plan.md              # This file
├── research.md          # Phase 0: constraint landscape + encoder candidates
├── data-model.md        # Phase 1: the hit shape (from the planning context slice)
├── quickstart.md        # Phase 1: how to validate the ruling + spike
├── contracts/
│   └── search-hit.md    # the hit + degradation contract F2 consumes
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
docs/
└── search-architecture.md    # THE RULING (the feature's product)

apps/calliope/
├── src/mcp/sidecar.ts        # untouched by the ruling; the spike compiles a
│                             # sibling entry to prove wasm-asset bundling
├── spikes/
│   └── wasm-compile-spike/   # the spike: minimal wasm-asset load under
│       ├── spike.ts          #   bun build --compile (linux-x64, executed)
│       └── README.md         #   observed result, recorded
└── package.json              # build:sidecar — the compile target being proven
```

**Structure Decision**: the ruling lives at `docs/search-architecture.md` (repo docs
dir, versioned with the governed code — spec Assumption, Default provenance). The
spike is a self-contained dir under `apps/calliope/spikes/`; it does not modify
`sidecar.ts` (the Touches pointer names sidecar.ts as the spike's *subject* — the
compile target whose build flags the spike replicates — not a file to edit).

## Reconcile summary (planning context → artifacts)

- **Verbatim from the planning context**: the Scope acceptance (N arms → RRF fuses
  available, UI names the dark); the hit shape slice (snippet, score, arm
  provenance) → data-model.md; the Decisions-slice (shape-not-service, RRF as
  degradation, FTS5-over-tantivy) → the ruling's decision table; the gap (wasm under
  `bun build --compile`, static-embedding fallback) → the spike + research.md.
- **Generated from the spec (planning context silent)**: the ruling's home
  (docs/search-architecture.md); the spike's location and mechanics; the
  N=0 / multi-arm-dedup / mid-session-join edge answers (written into the ruling as
  decided-by-this-plan, provenance-tagged).
- **Divergences**: none surfaced.

## Complexity Tracking

No constitution violations — table intentionally empty.
