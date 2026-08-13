---
description: "Forge work-chunks — binding, conflict-checked, executor-optimized"
---

# Tasks: The search verb in Calliope

**Input:** plan.md · spec.md · contracts/search-verb.md · data-model.md.
**Binding contract:** every task is binding spec. The executor follows it and does
NOT use judgment outside items marked `[OPEN]`. (Constitution I/II)

## Parallelization — conflict-checked (NOT optimistic)

- **Critical path:** T001 → T006 → T007 → T009.

| Lane | Tasks | Depends on | Distinct files (conflict-verified) |
| :--- | :--- | :--- | :--- |
| 1 | T001 | — | `src/fs-search/chunker.ts`, `store.ts` + tests |
| 2 | T002 [P] | — | `src/fs-search/fusion.ts` + test |
| 3 | T003 [P] | — | `src/fs-search/tokenizer.ts` + test |
| 4 | T004 | T003 | `src/fs-search/encoder.ts` + test |
| 5 | T005 | — | `src/fs-search/remote-embed.ts` + test |
| 6 | T006 | T001 T002 T004 T005 | `src/fs-search/index.ts` + tests |
| 7 | T007 | T006 | `src/mcp/server.ts`, `src/mcp/sidecar.ts`, `src/fs-client.ts` + tests |
| 8 | T008 [P] | — | `scripts/fetch-search-assets.ts`, `package.json` |
| 9 | T009 | all | (verification only) |

## Work-chunks

### T001 — Chunker + store  ·  M  ·  sequential
- **Serves:** FR-006/007, data-model.md.
- **Acceptance:** Given a normalized body, When chunked, Then blank-line-split
  paragraphs carry (ord, sha256 hash, text) and `.grace`/dotted paths are never
  walked; Given a re-indexed file, When one paragraph changed, Then exactly the
  changed row's hash differs and `vectors` gains at most one missing hash; FTS5
  external-content stays in sync through delete/replace; `snippet()` returns
  `…` marked excerpts; orphaned vectors sweep after re-index. Test-first.
- **Touches (RR):** write `file:apps/calliope/src/fs-search/chunker.ts`,
  `file:apps/calliope/src/fs-search/store.ts`,
  `file:apps/calliope/__tests__/fs-search-store.test.ts`.
- **Decisions-slice:** grain + schema [plan D1]; storage home `.grace/search.sqlite`
  [plan D1]; markers  [plan D6].
- **Conflicts-with:** none. · **Size basis:** schema + sync logic → M.

### T002 — RRF fusion  ·  S  ·  [P] lane-2
- **Serves:** FR-004; F1 invariants 1–5.
- **Acceptance:** Given ranked lists, When fused (k=60), Then a both-arms hit
  appears once with both provenances and accumulated score; one-list fusion is
  rank-identical (N=1 identity); empty input → empty output. Test-first.
- **Touches (RR):** write `file:apps/calliope/src/fs-search/fusion.ts`,
  `file:apps/calliope/__tests__/fs-search-fusion.test.ts`.
- **Decisions-slice:** RRF [F1]; k=60, top-128 in, 20 out [plan D6].
- **Conflicts-with:** none. · **Size basis:** one pure function → S.

### T003 — WordPiece tokenizer  ·  S  ·  [P] lane-3
- **Serves:** the encoder's input contract.
- **Acceptance:** Given `tokenizer.json`'s vocab, When "hello world" tokenizes,
  Then ids are [101, 7592, 2088, 102]; unknown runes → [UNK]; `##` continuations
  longest-match; output truncates at 256 tokens with [SEP] preserved. Test uses a
  minimal inline vocab fixture (no 711 KB asset in the repo). Test-first.
- **Touches (RR):** write `file:apps/calliope/src/fs-search/tokenizer.ts`,
  `file:apps/calliope/__tests__/fs-search-tokenizer.test.ts`.
- **Decisions-slice:** hand-rolled over transformers.js [research.md].
- **Conflicts-with:** none. · **Size basis:** one algorithm → S.

### T004 — The encoder  ·  M  ·  sequential (after T003)
- **Serves:** FR-003; plan D3/D4.
- **Acceptance:** Given resolved assets, When `embed(texts)` runs, Then int8[384]
  L2×127 vectors return (mean-pooled over attention mask); Given assets missing,
  Then construction reports unavailable (no throw into the query path); the
  integration test (real assets) auto-skips when absent. `Embedder` interface +
  counting `FakeEmbedder` for every other test.
- **Touches (RR):** write `file:apps/calliope/src/fs-search/encoder.ts`,
  `file:apps/calliope/__tests__/fs-search-encoder.test.ts`.
- **Decisions-slice:** ORT-web wasm proven [research.md]; resolution order [plan D4];
  lazy init [plan D8].
- **Conflicts-with:** none. · **Size basis:** session + pooling + resolution → M.

### T005 — Remote accelerator  ·  S  ·  [P] lane-5
- **Serves:** plan D5; the Consumes row.
- **Acceptance:** Given `CALLIOPE_EMBED_URL` set, When a bulk batch embeds, Then
  the endpoint's vectors are used only if 384-dim (first response probed; wrong
  dims refuse the endpoint for the process lifetime — bge-m3 must be refused);
  Given the endpoint down, Then batches fall back to the local embedder without
  darkening anything. Fetch-mocked tests.
- **Touches (RR):** write `file:apps/calliope/src/fs-search/remote-embed.ts`,
  `file:apps/calliope/__tests__/fs-search-remote.test.ts`.
- **Decisions-slice:** accelerator-only role [plan D5].
- **Conflicts-with:** none. · **Size basis:** one client + refusal rule → S.

### T006 — LocalSearchIndex  ·  L  ·  sequential
- **Serves:** FR-001/002/005/006; US1/US2/US3; SC-003.
- **Acceptance:** Given a root, When opened, Then catch-up scan indexes changed
  files by (mtime,size) diff; Given fs events, Then per-path 250 ms debounce +
  coalescing queue converge bulk storms without redundant rebuilds; Given watcher
  construction failure, Then a 30 s sweep substitutes; Given one edited paragraph,
  Then the counting FakeEmbedder logs EXACTLY one call (SC-003's test); Given
  `search(query, scope, k)`, Then FTS + semantic (when ready) fuse per contract
  with correct armsQueried/armsDark in every availability state (data-model
  table); scope prefix filters; the embed queue drains bulk backfill in the
  background respecting accelerator fallback.
- **Touches (RR):** write `file:apps/calliope/src/fs-search/index.ts`,
  `file:apps/calliope/__tests__/fs-search-index.test.ts`,
  `file:apps/calliope/__tests__/fs-search-incremental.test.ts`.
- **State:** encoder lifecycle (init → ready | unavailable); queue (idle →
  draining); per-query arm availability.
- **Budget:** semantic query = 1 forward pass + one typed-array scan (no ANN).
- **Decisions-slice:** watcher locus + fallback [plan D2]; lazy encoder [D8].
- **Conflicts-with:** none. · **Size basis:** orchestration + freshness + queue → L.

### T007 — The verb surfaces  ·  M  ·  sequential
- **Serves:** FR-001/008; the Exposes rows (`search(query, scope)`, the local index).
- **Acceptance:** Given the MCP server, When constructed WITH a provider, Then
  `search` answers the contract; WITHOUT one, Then honest darkness (`armsQueried:
  []`, both arms dark) — tool present on every backend; Given the sidecar, When
  `/body` receives `{verb:"search"}`, Then the same response returns (400 on empty
  query); Given a sidecar-authored write, Then `onWrite` triggers an immediate
  re-index (no watcher round-trip); the sidecar's tool-list test grows `search`
  (the surface pin).
- **Touches (RR):** write `file:apps/calliope/src/mcp/server.ts` (+tool),
  `file:apps/calliope/src/mcp/sidecar.ts` (dispatch + construction),
  `file:apps/calliope/src/fs-client.ts` (onWrite hook only — grain untouched),
  `file:apps/calliope/__tests__/mcp-search.test.ts`, sidecar test.
- **Decisions-slice:** provider seam [plan structure]; read-only verb [FR-008].
- **Conflicts-with:** T006 (imports index.ts) — sequential after.
- **Size basis:** two surfaces + a hook + tests → M.

### T008 — Assets script + packaging  ·  S  ·  [P] lane-8
- **Serves:** plan D4; quickstart.
- **Acceptance:** Given `bun run fetch-search-assets`, Then the four assets land in
  `apps/calliope/models/` from pinned URLs with sha256 verification and a clear
  refusal on mismatch; `models/` is gitignored; `build:sidecar` copies
  `models/` → `dist/search-assets/` when present (absence: warn, not fail).
- **Touches (RR):** write `file:apps/calliope/scripts/fetch-search-assets.ts`,
  `file:apps/calliope/package.json`, `file:.gitignore`.
- **Decisions-slice:** beside-binary packaging [plan D4 divergence].
- **Conflicts-with:** none. · **Size basis:** fetch + copy + pins → S.

### T009 — Verification pass  ·  S  ·  sequential (last)
- **Serves:** Constitution V; SC-001..004.
- **Acceptance:** lint + typecheck + full vitest green; the quickstart e2e (real
  assets, live sidecar, curl) observed and its output recorded in the completion
  report; the timing log over the synthetic corpus recorded (non-asserting).
- **Touches (RR):** none (runs things).
- **Conflicts-with:** all (last). · **Size basis:** verification only → S.

---
Done-when (the gate):
[x] every task: Serves + Acceptance + field-level Touches + Decisions-slice + size
[x] every [P] verified conflict-free (T002/T003/T005/T008 touch disjoint files)
[x] critical path identified (T001→T006→T007→T009); no cycles
[x] every Exposes shape traces to contracts/search-verb.md
[x] State + Budget present where stateful / perf-load-bearing (T006)
