# Contract — the log-offset stamp (F2)

Completes the master-plan Exposes row: block write provenance `(principal, session_uuid, kafka_offset)` on the row.

## Store contract

- `sections.kafka_offset bigint NULL` — caller's stamp verbatim; NULL = no session context; never defaulted.
- Write methods: `saveBody(nodeId, sections, authoredBy?, kafkaOffset?)` · `editSection(nodeId, sectionId, text, authoredBy?, kafkaOffset?)` · `applySectionOps(nodeId, ops, authoredBy?, kafkaOffset?)` · `splitSection(nodeId, sectionId, offset, authoredBy?, kafkaOffset?)` · `mergeSections(nodeId, firstId, secondId, separator?, authoredBy?, kafkaOffset?)`.
- `materialize` never stamps an offset (machine path).
- Guard (`types.ts`): `validateWriteProvenance(authoredBy?, kafkaOffset?)` throws unless the offset is absent or the author is a session principal.

## MCP verb contract (the same nine verbs as 024)

- New optional input on each: `kafka_offset?: integer ≥ 0` (≤ `Number.MAX_SAFE_INTEGER`).
- `kafka_offset` present ⇒ `authored_by` MUST be a session principal on the same call; violation rejects with an error naming the rule; nothing lands.
- Absent ⇒ NULL stored; behavior otherwise identical to 024.

## Read contract

- None added here. F9 reads `sections.authored_by` + `sections.kafka_offset` directly (its own Touches). pg returns bigint as a string — F9 parses.
- Fixture parity only: fixture write-events record `kafkaOffset` so MCP-layer tests can assert threading without docker.
