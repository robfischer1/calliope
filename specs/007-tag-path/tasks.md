---
description: "Forge work-chunks — binding, conflict-checked, executor-optimized"
---

# Tasks: C9 — The Tag Path

**Critical path:** T001 → T002 → T003 (sequential).

### T001 — tags module + TagStore · M
- **Acceptance:** `extractInlineTags` matches scan.ts's grammar (fixture parity cases incl. `#a/b`, `x#not`, `[[#not]]`, case-fold); `reconcileTags` computes the add/remove sets honoring explicit-survival; `PgTagStore` (ensure + upsert + delete + byNode + distinct) against real pg; `FixtureTagStore` for handler tests.
- **Touches:** `apps/calliope/src/tags.ts` (new), `apps/calliope/src/tag-store.ts` (new), tests.

### T002 — the hooks + the verbs · M
- **Acceptance:** `create_note` writes explicit tags (edges + mirror); the four body-write handlers reconcile inline tags for Note-kind nodes only (kind-gated via `dial.edges`); `list_by_tag` serves over `find_by_value` (graph hex, lowercase-normalized query); `list_tags` serves the mirror's distinct set; server registration behind the chaos facet + pg store; full gate green.
- **Touches:** `apps/calliope/src/mcp/tools.ts`, `src/mcp/server.ts`, `src/mcp/backend.ts`, `src/chaos-client.ts` (findByValue), tests.

### T003 — land + live probe · S
- **Acceptance:** branch lands via the door (CI green); live: create a probe note with explicit + inline tags → edges visible; `list_by_tag`/`list_tags` answer through the gateway (manifest reload — two NEW verb names); reconcile matrix probed live; debris `c9-probe-*` kept.
