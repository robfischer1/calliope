# Quickstart — validating F2 (session log-offset stamping)

Prerequisites: bun + docker (pg contract tests self-skip without docker).

## Run the gates

```bash
cd apps/calliope
bun run lint && bun run typecheck && bun run test
```

## What proves the feature (maps to spec Success Criteria)

1. **SC-001 (offset round-trip):** pg contract test writes via `applySectionOps(node, ops, PRINCIPAL, 42)` and reads `sections.kafka_offset` back as `'42'` (pg returns bigint as string).
2. **SC-002 (no context → NULL):** a write with author only (or nothing) stores `kafka_offset IS NULL`.
3. **SC-003 (pre-feature rows):** rows written before the column exist read as NULL; `ensureSchema()` is idempotent over an already-populated table.
4. **SC-004 (invalid never lands):** MCP tests — `kafka_offset` with a legacy/absent `authored_by` rejects naming the offset-requires-session-author rule; negative and non-integer offsets reject via schema; in each case zero rows/revisions land.

## Manual smoke (optional)

```bash
CALLIOPE_MCP_BACKEND=fixture bun run --cwd apps/calliope dev
# create_block(container_id, text,
#   authored_by="spiffe://notusmi.com/session/00000000-0000-4000-8000-000000000000",
#   kafka_offset=1234)
# → lands; read_body_revisions reports the event's kafkaOffset (fixture parity)
# create_block(container_id, text, kafka_offset=1234)  → rejects: offset requires a session author
```
