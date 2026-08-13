---
title: "Stamp Block Writes with the Session Log Offset"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: draft
---

# Stamp Block Writes with the Session Log Offset — Design Plan

> **Binding contract.** Every item is `decided` (executor MUST follow — no discretion)
> or `[OPEN]` (spec is silent and it matters — executor SURFACES it back, never invents).
> No advisory tier, no "use judgment." Open is the only license for discretion. (Constitution I/II)

## Summary

Add one nullable `bigint` column — `sections.kafka_offset` — and thread an optional per-call offset through the same write path F1 (024) built for the author. The pair the master plan's Exposes row names, `(principal, session_uuid, kafka_offset)`, is complete after this feature: the principal (which embeds the session uuid) landed in 024; this lands the offset. Contract: an offset REQUIRES a session-principal author on the same call (an offset without a session is a guess — rejected, never nulled silently); absent offset stores NULL. No backfill, no read-surface change (F9 reads the columns directly, per its own Touches).

## Architecture

| Path | Change |
| :--- | :--- |
| `apps/calliope/src/pg-client.ts` (Tail RR: "column") | `ALTER TABLE sections ADD COLUMN IF NOT EXISTS kafka_offset bigint` in `SCHEMA_SQL` (the tombstone-column precedent); write methods take optional trailing `kafkaOffset?: number` after `authoredBy?`, stamped at the same 7 INSERT sites; NULL when absent. |
| `apps/calliope/src/types.ts` (adjacent — surfaced) | `BodyClient` write-method signatures gain the trailing `kafkaOffset?: number`; the offset-requires-principal guard exported as `validateWriteProvenance()`. |
| `apps/calliope/src/fixture-client.ts` (adjacent — surfaced) | records `kafkaOffset` per write-event (test parity, as 024 did for the author). |
| `apps/calliope/src/mcp/tools.ts` (adjacent — surfaced) | the nine write helpers thread `kafkaOffset` to the client calls. |
| `apps/calliope/src/mcp/server.ts` (Tail RR: "accept the offset") | the nine write verbs gain optional `kafka_offset: z.number().int().min(0)`; the offset-requires-principal contract enforced before the client call, error naming the rule. |

## Contracts & Seams

### Exposes — the interface this provides

| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `db_field:sections.kafka_offset` | `bigint NULL` — the caller's stamp verbatim; NULL = no session context | decided |
| `mcp_tool:*` (nine sections-writing verbs) | existing inputs + optional `kafka_offset: int ≥ 0`; requires `authored_by` = session principal on the same call | decided |
| `fn:validateWriteProvenance` | `(authoredBy?: AuthoredBy, kafkaOffset?: number) => void` — throws when the offset has no session-principal author | decided |
| block write provenance (master-plan Exposes row) | `(principal, session_uuid, kafka_offset)` — complete: principal+uuid from 024's `authored_by`, offset here | decided |

### Consumes / Requires — the seams (what this CALLS)

| Dependency | Contract relied on (signature consumed) | Pin |
| :--- | :--- | :--- |
| 024's `AuthoredBy` family | `isAuthoredBy`, `SESSION_PRINCIPAL_RE` (the principal test in the guard) | landed — `a2fdcb2` (main) |
| session turns' `kafka_ref` | `{topic: "session-turns", partition: 0, offset: N}` — the offset's meaning (resolve-side, F9) | live (master-plan measured) |
| pg `bigint` | driver returns bigint as string on read; the store writes `number` in `[0, MAX_SAFE_INTEGER]` | pg@^8.22 |

### Resource-Reach — touched, field-level (VERIFIED against the real repo)

| RR pointer | Access | Role | Used by |
| :--- | :--- | :--- | :--- |
| `file:apps/calliope/src/pg-client.ts` (Tail RR) | write | SCHEMA_SQL + 7 INSERT sites + method params | store |
| `file:apps/calliope/src/mcp/server.ts` (Tail RR) | write | `kafka_offset` input + contract check on nine verbs | boundary |
| `file:apps/calliope/src/types.ts` (adjacent — surfaced) | write | interface params + the guard's home | all |
| `file:apps/calliope/src/mcp/tools.ts` (adjacent — surfaced) | write | helper threading | boundary |
| `file:apps/calliope/src/fixture-client.ts` (adjacent — surfaced) | write | event-level parity | tests |
| `db_field:sections.kafka_offset` | write | the column (new, nullable, no backfill) | F9 |

## Data model

- **`sections.kafka_offset`** (`bigint NULL`, new): the writing session's log offset at the moment of the write. NULL = no session context — never defaulted, never guessed. Immutable per row (stamped once at INSERT, like `authored_by`).
- Pre-existing rows: untouched; they read as NULL (FR-005, zero backfill).
- The Exposes pair: `session_uuid` is NOT a separate column — it is embedded in the 024 principal (`spiffe://{td}/session/{uuid}`); the Tail names exactly one column and one column lands.

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Column shape | one nullable `bigint`, no default | Tail: "(column)" — singular; NULL is the honest absence; bigint covers Kafka's int64 | Claude (Default — binding) | separate session_uuid column (derivable from the principal — a denormalization no reader needs yet) |
| Who supplies the offset | the caller, per-call, like 024's author | the session knows its own offset; same trust seam as the author it must accompany | Claude (Default — binding); gateway-side stamp stays **[OPEN]** (master-plan gap, carried) | gateway stamp (needs Charon/Hades changes outside this repo's RR) |
| Offset without a session author | REJECTED at the boundary (and re-checked in the store guard) | spec US2-2/FR-003: a guess is the failure mode; silent null would hide caller bugs | Claude (Default — binding) | silently store null (hides the bug), store it anyway (poisons replay) |
| Param shape | trailing positional `kafkaOffset?: number` after `authoredBy?` | consistent with 024's fresh API; an options-bag refactor would churn a one-feature-old surface — flagged as follow-up, not smuggled in | Claude (Default — binding) | `{authoredBy, kafkaOffset}` options object (cleaner at 3+ params; separate refactor) |
| Validation range | integer, `0 ≤ n ≤ Number.MAX_SAFE_INTEGER` | JS number safety below pg bigint's ceiling; a real Kafka offset fits | Claude (Default — binding) | string-typed offsets (pushes parsing to every caller) |
| Read exposure (revisions/replay) | **REVISED at implement (surfaced):** `RevisionMeta` gains `kafkaOffset: number \| null` (pg: `max(kafka_offset)` per event; fixture: recorded) | without it, fixture-parity/MCP tests cannot observe threading (docker-free), and F8/F9 read it anyway; the original "none" made the parity contract untestable | Claude (Default — binding; revision noted in completion report) | none-here (original — untestable parity) |
| Bus-unavailable behavior | out of scope — the caller simply has no offset and omits it (NULL) | the master-plan gap ("behaviour when the session bus is unavailable") resolves to the NULL contract on the write side; anything more is session-side policy | **[OPEN]** surfaced for the session/caller side | — |

## Dependencies

- Guard + interface params (`types.ts`) precede clients; clients precede tools; tools precede server. No cycles.
- Inter-feature (Tail, verbatim): consumes F1 (landed, `a2fdcb2`); **gates F9**.

## Impact

| Slice | Impact (0–10) |
| :--- | :--- |
| Column + store stamping | 4 |
| Boundary contract (offset⇒principal) | 5 |

## Open & risk

- **[OPEN] (master-plan gap, carried):** gateway-side stamping (Charon/Hades) as the eventual supplier — would move the trust boundary off the caller; outside this repo's RR.
- **[OPEN] (master-plan gap, resolved to NULL write-side, session-side surfaced):** when the session bus is down the caller has no offset; the write contract is "omit → NULL." Whether sessions should queue/refuse writes in that state is caller policy, not the store's.
- **Divergence surfaced (RR):** Tail lists two files; `types.ts`, `tools.ts`, `fixture-client.ts` are compilation/threading adjacents, same shape as 024's surfaced set.
- **Risk:** pg returns `bigint` as a string on read — F9's reader must parse; noted so it is not rediscovered.
- **Risk:** Clover4 lands 028–031 touching `server.ts`/`tools.ts` — pull merged main before landing (process).

---
Definition of Ready (the gate — must pass, not vacuously):
[x] every decision resolved + provenance-tagged (incl. defaults) — 6 decided + 2 [OPEN] surfaced
[x] Contracts & Seams complete — shapes named both directions, deps pinned
[x] Resource-Reach field-level AND verified against the real repo (line-verified against post-024 main)
[x] dependencies stated, no cycles
[x] constitution check: I (decided/[OPEN] only) · II (defaults binding) · III (both seam sides shaped) · IV (Acceptance falsifiable, quickstart maps SCs to tests) · V (gate + read-back defined)
