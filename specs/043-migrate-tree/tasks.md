---
description: "Forge work-chunks — binding, conflict-checked, executor-optimized"
---

# Tasks: Migrate Sections to Blobs and Tree

**Critical path:** T001 → T002 → T003 (single lane).

### T001 — AdmitResult carries the transaction  ·  S
- **Acceptance:** `AdmitResult.tx?: number`; the live dial parses themis's
  `tx` answer; the fixture dial stamps its own log tx on every admitted
  batch; no existing caller breaks.
- **Touches:** `file:apps/calliope/src/chaos-client.ts`.

### T002 — The replay engine + entry  ·  L
- **Acceptance:** exactly the plan's "The replay" section, steps 1–7,
  binding: enumeration + tenant rule; marker skip/refuse; ascending
  revision replay diffed on ids + supersessions (first-predecessor slot
  continuity, merge removals); blob-first per revision, ONE admit per
  non-empty revision; `m:<sectionId>` labels; provenance facts in the same
  batch; revision→tx report rows incl. original author/iso; two-sided
  parity (HEAD + per-revision as-of), mismatches named, nonzero exit;
  comments_on → slot-to-slot facts with findByValue resolution and
  edge-precheck idempotency; `--probe` read-only counts; `--limit`,
  `--node` filters.
- **Touches:** create `file:apps/calliope/src/mcp/migrate-tree.ts`; read
  `pg-client.ts` revision readers; call tree builders + ProseStore + dial.

### T003 — The honest suite  ·  L
- **Acceptance:** old store = REAL postgres exercised through
  PgBodyClient's own writes (saveBody + applySectionOps: edits, reorders,
  deletes, a merge via supersessions, an ops-only body, a comment +
  comments_on row); new stores = fixture dial + blobs. SC-001 (full parity
  incl. every revision as-of), SC-002 (second run: zero admits, zero
  mints), SC-003 (post-marker old-store write → refusal naming the
  container), SC-004 (comment slot→target slot fact resolvable). Probe
  mode touches nothing (admit count unchanged).
- **Touches:** create `file:apps/calliope/__tests__/migrate-tree.test.ts`.

---
Done-when: all tasks ✓ · binding steps trace to plan ✓
