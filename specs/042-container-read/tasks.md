---
description: "Forge work-chunks — binding, conflict-checked, executor-optimized"
---

# Tasks: The Container Read and History

**Critical path:** T001 → T002 → T003 → T004 → T005 (single lane).

### T001 — getTexts (batched)  ·  S
- **Acceptance:** `ProseStore.getTexts(ids)` returns a Map with every id
  that resolves; absent ids are simply missing (the caller marks dangling);
  pg: ONE `SELECT id, text … WHERE id = ANY($1)`; fixture: map walk; empty
  input → empty map, no query.
- **Touches:** `file:apps/calliope/src/blob-store.ts`.

### T002 — dial reads + the fixture log  ·  M
- **Acceptance:** ChaosDial gains `quadsFrom(subjects, asOfTx,
  predicateNames, graph?)` (live: names → sha256 hex; answer rows
  normalized to {s, p?, o, g, oDomain} with `blob:` parsed), `resolveScalars
  (hashes)`, `history(subjects, follow, graph?)`; Fixture: admits stamp
  tx (monotonic), edge ops log {tx, s, predicate, value, domain, added};
  quadsFrom replays ≤ asOf (nil = current); history closes over follow-pred
  node objects EVER asserted, answers distinct txs ascending with the
  fixture author; existing `edges()` behavior unchanged (current state).
- **Touches:** `file:apps/calliope/src/chaos-client.ts`.

### T003 — the read assembly  ·  M
- **Acceptance:** `readContainer(facet, container)` (HEAD): tree via
  `readTree` + ONE `getTexts`; blocks ordered; missing text → `{text: null,
  dangling: true}`; empty container → `{blocks: []}`. As-of:
  `readContainer(facet, container, {asOfTx})`: members via
  quadsFrom(container, asOf, [tree_member]); per-slot position/content via
  quadsFrom(slots, asOf, [tree_position, tree_content]); positions resolved
  via resolveScalars; later-removed members present at asOf < removal.
  `containerHistory(facet, container)` = dial.history([container],
  [tree_member], scope-graph? nil) passed through.
- **Touches:** create `file:apps/calliope/src/container-read.ts`.

### T004 — the verbs  ·  S
- **Acceptance:** `read_container` {container, as_of_tx?, tenant?} and
  `container_history` {container, tenant?} register beside write_container
  (same facet presence rule), answer structuredContent, and surface store
  errors as tool errors.
- **Touches:** `file:apps/calliope/src/mcp/server.ts`.

### T005 — suite + measurement  ·  M
- **Acceptance:** SC-001 (ordered+text, empty, dangling via a content fact
  naming an unminted blob id); SC-002 (edit then remove a member: as-of
  before removal shows it with its THEN-current text; head read excludes);
  SC-003 (N edits → N transactions listed ascending); SC-004: the real-pg
  blob suite gains a 50-blob batched-fetch timing whose result is written to
  `specs/042-container-read/measurement.md` (mean of ≥5 runs, machine
  noted).
- **Touches:** create `__tests__/container-read.test.ts`; write
  `__tests__/blob-store.test.ts` (timing case); write `measurement.md`.

---
Done-when: all tasks ✓ · Exposes trace to plan ✓
