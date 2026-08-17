---
description: "Forge work-chunks — binding, conflict-checked, executor-optimized"
---

# Tasks: The Container Write

**Input:** plan.md · spec.md. **Binding:** Constitution I/II.
**Critical path:** T001 → T002 → T003 → T004 (single lane).

### T001 — ProseStore + the fixture store  ·  S
- **Acceptance:** `ProseStore` names exactly {mint, getText, findByContent,
  search}; `BlobStore implements ProseStore` with zero behavior change;
  `FixtureBlobStore` dedupes byte-identically (same text → same id, no new
  entry), round-trips text, answers null for absent, search returns [] —
  enough for the write path's tests, not a search engine.
- **Touches:** write `file:apps/calliope/src/blob-store.ts`.
- **Conflicts-with:** none. **Size basis:** interface extraction + a Map → S.

### T002 — writeContainer: net-out → mint → one admit  ·  M
- **Acceptance:** Given ops, Then blobs mint BEFORE any admit (order
  observable in the fixture: mints happen even when admit refuses); an
  update whose mint answers `oldBlobId` DROPS; all-dropped → `{noop: true}`,
  zero admits; surviving ops compose via F3 builders ONLY (no raw op
  literals) into ONE admit at `scope(tenant)`; add labels are `b:<position>`;
  refusal throws `ChaosClientError` carrying the gate's violations verbatim.
- **Touches:** create `file:apps/calliope/src/container-write.ts`; call
  `module:blob-store`, `module:tree`, `dial.admit`.
- **Conflicts-with:** T001 (imports). **Size basis:** two-phase engine with
  netting + refusal contract → M.

### T003 — The facet and the verb  ·  M
- **Acceptance:** `Backend.containers` present on pg (BlobStore over the ONE
  shared pool + the existing LiveChaosDial) and fixture (FixtureBlobStore +
  the existing FixtureChaosDial — the same dial instance the chaos facet
  holds, so notes minted via create_note are addressable); `write_container`
  registers only when the facet exists (the create_note presence pattern);
  args validated {container hex64, ops non-empty, tenant enum default
  notes}; answers {noop, applied, minted, blobIds} and surfaces violations
  as the tool-error shape the other verbs use.
- **Touches:** write `file:apps/calliope/src/mcp/backend.ts`,
  `file:apps/calliope/src/mcp/server.ts`.
- **Conflicts-with:** T002. **Size basis:** facet wiring + one registration → M.

### T004 — The suite  ·  M
- **Acceptance:** SC-001 (3-block container, one update: exactly 1 new blob
  in the store, 1 retract+assert pair on that slot, other slots' edges
  untouched); SC-002 (identical re-submit: zero admits, blob count
  unchanged); SC-003 (mixed batch: one admit, only real ops in it); SC-004
  (refuseWith: violations surfaced, tree unchanged, minted blob present but
  unreferenced); SC-005 (single add → one member); reorder/moves mint
  nothing; two adds in one save carry distinct labels.
- **Touches:** create `file:apps/calliope/__tests__/container-write.test.ts`.
- **Conflicts-with:** none. **Size basis:** ~9 tests → M.

---
Done-when: all tasks ✓ · no [P] · Exposes trace to plan ✓
