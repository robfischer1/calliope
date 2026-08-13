# Quickstart — validating F1 (AuthoredBy widening)

Prerequisites: bun + docker (the pg contract tests run against an ephemeral postgres and self-skip without docker).

## Run the gates

```bash
cd apps/calliope
bun run lint && bun run typecheck && bun run test
```

## What proves the feature (maps to spec Success Criteria)

1. **SC-001 (principal round-trip):** pg contract test writes a block with `authoredBy: "spiffe://notusmi.com/session/<uuid>"` via `applySectionOps`, reads `sections.authored_by` back, and asserts the exact principal. Fixture + urania threading tests assert the same per-call value reaches `capture()`.
2. **SC-002 (legacy regression):** existing provenance tests (`urania-client.test.ts` §threading) still pass untouched; new cases assert `"human"`/`"calliope"` writes behave byte-identically (default stamping preserved).
3. **SC-003 (zero migration):** the pg contract suite runs `ensureSchema()` against the pre-existing DDL — no ALTER appears in the diff; rows written before the per-call param (default-stamped) read back unchanged.
4. **SC-004 (revision authorship):** revisions test writes two revisions under different authors and asserts `readRevisions` reports each verbatim.
5. **FR-005 (boundary rejection):** MCP-layer test calls a write verb with `authored_by: "gandalf"` and asserts a validation error naming `human`, `calliope`, and the `spiffe://…/session/{uuid}` form; and that no write occurred.

## Manual smoke (optional)

```bash
# fixture backend — no infra needed
CALLIOPE_MCP_BACKEND=fixture bun run --cwd apps/calliope dev
# then over MCP: create_block(container_id, text, authored_by="spiffe://notusmi.com/session/00000000-0000-4000-8000-000000000000")
# read_revisions on the block → authoredBy carries the principal verbatim
```
