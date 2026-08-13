# Data model — Stamp Block Writes with the Session Log Offset

The master-plan Exposes slice: **block write provenance — `(principal, session_uuid, kafka_offset)` on the row** (F1+F2 jointly; F1 landed the principal, this lands the offset).

## `sections.kafka_offset` (new column)

- DDL (idempotent, in `SCHEMA_SQL`): `ALTER TABLE sections ADD COLUMN IF NOT EXISTS kafka_offset bigint;`
- Value domain: `NULL` (no session context) or a non-negative int64 — the writing session's position in the session-turns log at the moment of the write.
- Written once at INSERT (all 7 sites + never on `materialize` — machine writes carry no offset); immutable per row.
- **Invariant:** `kafka_offset IS NOT NULL` ⇒ `authored_by` is a session principal (enforced at the boundary and in `validateWriteProvenance`; not as a DB CHECK — the store guard is the enforcement point, a CHECK would need principal-regex in SQL for no reader).
- Pre-existing rows: read as NULL; zero backfill.

## The complete provenance read (for F9)

```
sections.authored_by   -- 'human' | 'calliope' | spiffe://{td}/session/{uuid}
sections.kafka_offset  -- bigint NULL (pg driver returns string on read)
```

`session_uuid` = the principal's tail; `(session_uuid, kafka_offset)` = the exact replay cut `recall_session_turns(session, until=offset)` will serve (F3/F9).

## TypeScript surface

```
BodyClient write methods: (…, authoredBy?: AuthoredBy, kafkaOffset?: number)
validateWriteProvenance(authoredBy?: AuthoredBy, kafkaOffset?: number): void
  — throws unless kafkaOffset === undefined, or authoredBy matches SESSION_PRINCIPAL_RE
```
