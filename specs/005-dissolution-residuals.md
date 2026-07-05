# C5 — Dissolution-bridge residuals (spec-lite, S)

**Head:** Archive the retired bridge's data — `dissolutions`, `file_revision_dissolutions`, `materialization_events` — under Calliope as historical record, and deregister the dissolution CLI/MCP surface as RETIRED, so the bridge's bookkeeping survives the machinery's death.

**Reconcile (2026-07-04, Birch):** live counts 441 / 935 / 31. The bridge's ONE live caller is vault-mcp's dissolve step 2 (`/dissolution/declare`) — per the master-plan's own B7 decision [Rob: machinery RETIRED, data archived], the declare step retires from the dissolve flow with the bridge (the Calliope documents table — source*path + created_at + dedup — IS the go-forward record of what dissolved when). vault-mcp's dissolution read verbs (`dissolution_lookup` / `dissolution_for_revision` / `list_dissolution_waves`) retire with it; historical queries go to the `archive*\*` tables.

**Tasks:** T1 archive copy + count parity + artifact (`migrate-dissolution-archive.ts`). T2 vault-mcp: dissolve drops the declare step; the three read verbs retire. T3 phdb: de-tool `declare_dissolution`/`dissolution_audit`, detach `/dissolution/*` + `/emit`? (NO — `/emit` stays, not bridge), detach CLI `dissolution`(11). T4 records: Checklist RETIRED row + board close.

**Acceptance:** counts match 3/3 with artifact; a dissolve still works end-to-end (write → delete, no declare); `phdb dissolution` → No such command; MCP surface drops by 2.
