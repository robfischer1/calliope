---
description: "Forge work-chunks — binding, conflict-checked, executor-optimized"
---

# Tasks: Route the pg arm through Eros

**Input:** plan.md · spec.md. **Binding contract:** Constitution I/II.

## Parallelization

- **Critical path:** T001 → T003. T002 (eros) is repo-independent of T001.

| Lane | Tasks | Depends on | Distinct files |
| :--- | :--- | :--- | :--- |
| 1 | T001 | — | calliope: eros-provider.ts, http.ts, main.ts, test |
| 2 | T002 [P] | — | eros: server.py, search.py, test |
| 3 | T003 | T001 T002 | (gates + land both) |

### T001 — ErosSearchProvider + wiring  ·  M
- **Acceptance:** plan D1–D3 verbatim; without `CALLIOPE_EROS_URL` nothing is
  constructed (F2's honest-dark no-provider path stands); fixture tests cover
  mapping (title/no-title), k pass-through, dark-on-error, dark-on-timeout;
  no SQL/tsvector/embedding anywhere in the diff (SC-003 by inspection).
- **Touches:** write `file:apps/calliope/src/fs-search/eros-provider.ts`,
  `file:apps/calliope/src/mcp/http.ts`, `file:apps/calliope/src/mcp/main.ts`,
  `file:apps/calliope/__tests__/eros-provider.test.ts`.

### T002 — Eros source filter  ·  S  ·  [P]
- **Acceptance:** `search(source=...)` scopes BOTH arms to one source_table
  (parameterized SQL, no interpolation); None = unchanged behavior; pytest
  proves the filter (fixture rows across two source_tables → only the named
  one returns) in fts mode (no embed client needed) and threads the param in
  semantic SQL (asserted via SQL text or a fake embedder).
- **Touches:** write `file:src/eros/server.py`, `file:src/eros/search.py`,
  `file:tests/test_search_source_filter.py`.

### T003 — Gates + land  ·  S
- **Acceptance:** calliope lint/tsc/vitest green; eros ruff + pytest green;
  both PRs merged through the door; observed counts reported.

---
Done-when: tasks carry acceptance+touches; [P] verified (different repos); no cycles.
