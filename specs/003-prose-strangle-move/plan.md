---
title: "The Prose Strangle — writes + writing-arc (C3)"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: draft
---

# C3 — Design Plan

> Binding. Reconciled against the master-plan C3 tail (authoritative) + the LIVE backend (which supersedes the tail's assumptions — see the spec's reconcile note): the phdb prose surface is dead-on-live in its entirety; the strangle builds the documents successor, migrates the archive, repoints the dissolve, and retires the rest explicitly. The Harmonia deregistration (Checklist §A, 2026-07-03) is the proven playbook this follows verb-for-verb.

## Summary

Calliope grows a **document store** beside its section store: `document-store.ts` (`PgDocumentStore` on the same calliope-db pool) with the project dedup contract (`(source_path, raw_hash)` → idempotent), an MCP verb pair (`write_document`, `read_documents`) registered beside the body verbs, and HTTP routes mirroring the phdb wire contract (`POST /write/document`, `GET /read/documents`) so vault-mcp's translator payloads pass through unchanged. A migration ports the 2,770 `history.documents` rows with a content-hash parity artifact (the C2 house pattern). vault-mcp's dissolve repoints its `DOC_ENDPOINT` payloads to the star verb via hades (`call_verb`, exactly the `write_entity_typed`→harmonia shape of PR #342); its `PLAN_ENDPOINT` path drops (plans are graph bodies). Then phdb deregisters the five verbs + four routes (detach pattern; live verification). `write_plan` and the writing-arc trio retire with named successors — no star port for dead surfaces.

## Live-reality basis (verified 2026-07-04)

| Surface                                                | Live state                                                                                                                      | Disposition                                                                                        |
| :----------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------- |
| `write_document`                                       | DEAD — SQLite `INSERT OR IGNORE` + columns absent from PG `history.documents`; MAX(created_at) 2026-06-10                       | **strangle** — build the star successor                                                            |
| `history.documents`                                    | 2,770 rows (all vault-dissolve artifacts; web content is `external.*` = Clio's — the row split is already schema-level)         | **migrate** with parity                                                                            |
| `write_plan`                                           | DEAD — no `plans` table on PG; plans are graph bodies since the naming close                                                    | **retire** (RETIRED-superseded)                                                                    |
| `writing_arc`/`writing_session_detail`/`writing_stats` | DEAD — tables exist, 0 rows; code short-circuits (`#746`)                                                                       | **retire** — successor = the Aglaia block-op stream (C4's succession gap, resolved with live data) |
| vault-mcp dissolve                                     | POSTs `/write/document` `/write/plan` `/write/entity`; entity leg ALREADY strangled (harmonia PR #342 — `call_verb` over hades) | **repoint** doc leg; drop plan leg                                                                 |

## Architecture

| Piece             | Home                                                                  | Responsibility                                                                                                                                                                                                                                                                                                             |
| :---------------- | :-------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PgDocumentStore` | `calliope/src/document-store.ts` (new)                                | schema (`documents`: id bigserial PK, schema_type, title, source_path, file_path, body_text, content_hash (sha256 body), raw_hash, metadata jsonb, source_kind, created_at; UNIQUE (source_path, raw_hash)); `write` (ON CONFLICT DO NOTHING → `{deduped}`), `byId`, `bySourcePath`, `list({schema_type?, since?, limit})` |
| MCP verbs         | `src/mcp/server.ts` (+ `tools.ts`)                                    | `write_document` (payload = the phdb HTTP contract fields), `read_documents` (id / source_path / list) — registered beside the body verbs, served through hades bare (the calliope star route)                                                                                                                             |
| HTTP routes       | `src/mcp/http.ts`                                                     | `POST /write/document` + `GET /read/documents` mirroring the phdb wire shapes (the translator's payloads land unmodified)                                                                                                                                                                                                  |
| migration         | `src/mcp/migrate-documents.ts`                                        | source = phdb PG (`PHDB_DATABASE_URL`), dest = calliope-db; idempotent (dedup key), `--probe` mode, parity = per-row sha256(body_text) compare + count; exports the artifact JSON (C2 pattern)                                                                                                                             |
| repoint           | `vault-mcp/src/vault_mcp/hades_client.py` (+ the endpoint dispatcher) | `write_document(payload)` → `call_verb("write_document", …)`; dispatcher routes `DOC_ENDPOINT` → star, stops emitting `PLAN_ENDPOINT` payloads (translator: plan notes → document payload only)                                                                                                                            |
| deregister        | `personal-history-db` PR                                              | de-tool 5 MCP verbs + detach 4 HTTP routes (code stays); restart; verify counts + 404s (the #972/#973 house pattern)                                                                                                                                                                                                       |

## Decision Log

| Decision               | Resolution                                            | Rationale                                                                                                                                    | Provenance                                                |
| :--------------------- | :---------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------- |
| `write_plan` successor | RETIRE — no port                                      | tail's own gap ("plans are graph bodies now"), resolved with live data: no PG table, no live caller, board+Calliope own plan structure+prose | tail (gap) + live reality                                 |
| writing-arc succession | RETIRE — block-op stream is the successor             | C4's gap resolved with live data (0 rows, short-circuited); porting a dead analytics surface would fake the strangle                         | Claude (reconcile) — flag to Rob in the completion report |
| documents row split    | ALL of `history.documents` → Calliope                 | web/article content already lives in `external.*` (Clio); the split the tail asked to surface is already schema-level                        | data (verified)                                           |
| Wire contract          | mirror phdb's HTTP payload shapes verbatim            | the translator (note→payload) does not move; the sink stays note-ignorant (FR-004)                                                           | decided (tail)                                            |
| Parity                 | content-hash (sha256 over body_text) per row + counts | tail-decided ("parity = content-hash for prose")                                                                                             | tail                                                      |
| Plan-note dissolves    | document payload only post-repoint                    | plan METADATA's home is the graph; the body is the document                                                                                  | Claude (Default)                                          |

## Open & risk

- **Migration connectivity**: the script needs both `PHDB_DATABASE_URL` and `CALLIOPE_DATABASE_URL` reachable from one runtime (nas01 docker run, the C2 precedent); resolve concretely at build.
- **vault-mcp restart**: the dissolve service runs host-side (the Harmonia repoint set `HADES_URL`/`HADES_TOKEN` on the Windows service via Rob) — the repoint PR may need Rob's service restart; the env vars ALREADY exist from #342, so this is restart-only, not config.
- **phdb service restart** after the deregistration PR — same as #972/#973 (house pattern; note which host serves phdb-mcp at build time).
- Retirements are Claude-reconciled from live data, not Rob-gated — the completion report flags both (write_plan, writing-arc) for veto.

---

DoR: [x] decisions tagged · [x] shapes named · [x] RR verified · [x] constitution I–V hold.

# Tasks (inline)

- **T001 (calliope)**: `PgDocumentStore` + verbs + HTTP routes + tests (pg-backed store tests follow the repo's existing test seam) → gate green → PR → deploy → verbs live via hades.
- **T002 (migration)**: migrate + parity 2770/2770 green + artifact exported; re-run migrates zero.
- **T003 (repoint)**: vault-mcp doc-leg → star verb; plan-leg drops; PR; a REAL dissolve proves SC-001 end-to-end; phdb untouched.
- **T004 (deregister)**: phdb PR (5 verbs, 4 routes, detach pattern) → restart → verify (surface count, 404s).
- **T005 (record)**: Checklist §A Calliope row → DEREGISTERED with successors; C3 board node closed; retirement flags in the completion report.
