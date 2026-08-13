---
description: "Forge work-chunks — binding, conflict-checked, executor-optimized"
---

# Tasks: Rule the desktop search architecture

**Input:** plan.md · spec.md · contracts/search-hit.md · research.md.
**Binding contract:** every task is binding spec. The executor follows it and does NOT
use judgment outside items marked `[OPEN]`. A needed deviation is surfaced back, not
decided locally. (Constitution I/II)

## Parallelization — conflict-checked (NOT optimistic)

- **Critical path:** T001 → T002 (the ruling records the spike's observed result;
  it cannot be finished before the spike runs).

| Lane | Tasks | Depends on | Distinct files (conflict-verified) |
| :--- | :--- | :--- | :--- |
| 1 | T001 | — | `apps/calliope/spikes/wasm-compile-spike/*` |
| 2 | T002 | T001 | `docs/search-architecture.md` |

## Work-chunks

### T001 — The wasm-under-compile spike  ·  S  ·  sequential
- **Serves:** FR-003 / SC-002 — close the one unverified constraint before F2.
- **Acceptance:** Given a minimal entrypoint that embeds and instantiates a `.wasm`
  module (the way an ONNX runtime would load its asset), When compiled with
  `bun build --compile --target=bun-linux-x64` and the resulting binary is executed,
  Then the binary instantiates the module and prints the result of an exported wasm
  function (PASS), and `--target=bun-windows-x64` builds without error; OR either
  step fails, which is the equally-valid FAIL result. Observed output — not the
  expectation — is recorded in `spikes/wasm-compile-spike/README.md`.
- **Exposes:** — (spike; nothing lands on the verb surface).
- **Touches (RR, field-level):** write `file:apps/calliope/spikes/wasm-compile-spike/spike.ts` ·
  write `file:apps/calliope/spikes/wasm-compile-spike/README.md` · run
  `bun build --compile` (the `build:sidecar` flag shape from
  `apps/calliope/package.json`, replicated — sidecar.ts itself is NOT edited).
- **State:** —.
- **Budget:** the spike binary must run to completion locally; no perf budget.
- **Decisions-slice:** FTS5-over-tantivy [Claude, verified] fixes the compile target
  as immovable; wasm-vs-static-embeddings branch decided by this spike's result
  [Default, per research.md — the executor inherits a branch, not discretion].
- **Conflicts-with:** none (isolated new dir).
- **Open:** none — both outcomes are specified.
- **Size basis:** one entrypoint, two build invocations, one README → S.

### T002 — Write the ruling  ·  S  ·  sequential
- **Serves:** FR-001/002/004/005, SC-001/003 — the feature's product; User Story 1.
- **Acceptance:** Given `docs/search-architecture.md`, When read alone (no other
  document), Then it names: local FTS = SQLite FTS5 (`bun:sqlite`); local semantic =
  int8 wasm-ONNX encoder OR static embeddings **per T001's observed result**; fusion
  = RRF with N=1 identity; remote arm = Eros `eros_search` joining when reachable,
  evaluated per-query; the degradation contract (armsQueried/armsDark per
  `contracts/search-hit.md`, N=0 distinguishable from zero matches, multi-arm hits
  fused once with full provenance); and the three inherited prohibitions (no local
  ANN; no second FTS on the remote store; nothing breaking `bun build --compile`) —
  every decision carrying provenance ([Rob] / [Claude, measured/verified] /
  [Default]) and the corpus + MAC measurements restated as the deciding constraints.
- **Exposes:** the hit + envelope shapes (copied from `contracts/search-hit.md`,
  decided) — documentation of the seam F2 implements, not code.
- **Touches (RR, field-level):** write `file:docs/search-architecture.md`.
- **State:** —.
- **Budget:** —.
- **Decisions-slice:** Eros as a shape, not a service [Claude]; RRF as the
  degradation mechanism [Claude]; FTS5 over tantivy [Claude, verified]; semantic arm
  ships in v1 [Rob]; no ANN [Claude, measured]; vector spaces never shared [Claude];
  model sizes unverified-from-training → flagged as F2 build-time check [Claude].
- **Conflicts-with:** none (distinct file from T001).
- **Open:** none.
- **Size basis:** one document reconciling already-made decisions → S.

---
Done-when (the gate):
[x] every task: Serves + Acceptance + field-level Touches + Decisions-slice + size
[x] every [P] verified conflict-free (no [P] tasks — sequential chain of 2)
[x] critical path identified (T001 → T002); no dependency cycles
[x] every Exposes shape traces to plan.md Contracts & Seams (search-hit.md)
[x] State + Budget present where stateful / perf-load-bearing (none are)
