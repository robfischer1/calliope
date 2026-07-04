---
title: "Cut 1 — the Prose-Body Facet Carve (Sovereign Store)"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: draft
---

# C2 — Design Plan

> Binding contract. Every item `decided` or `[OPEN]`. Rob's gate decisions (sovereign-now, all-bodies) are decided substrate.

## Summary

Stand up `calliope-db` (pgvector/pg17, private net, bws-held password) in this star's compose stack; implement `PgBodyClient` (BodyClient over pg with identical read/save/edit semantics); make backend kind `pg` the configured default; migrate every body out of the Chaos `moirae` graph with per-node content-hash parity; cut over; retract the body triples from Chaos; ship a drift probe + the facet definition. Tool handlers (`tools.ts`/`server.ts`/`http.ts`) are untouched — they are pure over `BodyClient` (verified), which is what makes the wire byte-identical.

## Architecture

- `src/pg-client.ts` — `PgBodyClient implements BodyClient` (+ schema bootstrap `ensureSchema()`); `pg` (node-postgres) dependency.
- `src/mcp/backend.ts` — new kind `"pg"`; auto-selected when `DATABASE_URL` set; `"urania"` (chaos) kind retained for migration reads; `"hades"`/`"fixture"` unchanged.
- `src/mcp/migrate.ts` — one-shot command (`node dist/mcp/migrate.js [--retract] [--probe]`): enumerate `hasPart`-carrying subjects via chaos `graph_edges(name_hash("moirae"))`, read each body via the chaos BodyClient, upsert into pg preserving section ids, emit parity JSON (per-node sha256 over ordered `(order_key, text)` pairs, old vs new). `--probe` = count remaining body triples in chaos (drift probe). `--retract` = post-cutover retraction via chaos `capture` retract ops.
- `compose.yaml` — `calliope-db` service (pgvector/pgvector:pg17, volume `calliope-db-data`, private `calliope-net`) + `calliope-mcp` gains `DATABASE_URL` + joins `calliope-net`.
- `.forgejo/workflows/deploy.yml` — deploy step exports `CALLIOPE_DB_PASSWORD` from the repo Actions secret (compose interpolation).
- `docs/body-facet.md` — the facet definition (FR-006).
- `__tests__/pg-client.test.ts` — contract tests vs a real ephemeral postgres (`docker run` in test setup; auto-skip when docker unavailable).

## Contracts & Seams

### Exposes

| Surface              | Signature / shape                                                                                                                                                                   | State               |
| :------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------ |
| the five verbs       | unchanged wire shapes (`read_body`/`write_body`/`append_section`/`edit_section` + athena's `revise_section_node` consuming the same store via these verbs' semantics)               | decided — invariant |
| `db:calliope-db`     | pg17+pgvector, db `calliope`, table `sections(id, node_id, text, order_key, authored_by, active, supersedes, created_at)`; reachable ONLY on `calliope-net`                         | decided             |
| `docs/body-facet.md` | the facet definition: body = the section tree of a node (ALL nodes, incl. work-nodes); owner = Calliope; Athena's `hasBody` section-node literal = graph-facet scalar, out of facet | decided (Rob)       |
| drift probe          | `migrate.js --probe` → `{remaining_haspart: N}`; expected 0 post-retraction                                                                                                         | decided             |

### Consumes / Requires

| Dependency             | Contract relied on                                                                                                                                                                                                        | Pin                                |
| :--------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------- |
| chaos engine-service   | `graph_edges(graph, …)` (enumeration) · `materialize_edges`/`materialize` (reads via existing LiveUraniaCapture) · `capture` (retraction ops) — **the pinned substrate contract, needed only until retraction completes** | `http://chaos:8206/mcp`, east-west |
| `pg` npm package       | Pool/transactions                                                                                                                                                                                                         | ^8                                 |
| bws (pantheon)         | `CALLIOPE_DB_PASSWORD` secret of record                                                                                                                                                                                   | bws project pantheon               |
| Forgejo Actions secret | `CALLIOPE_DB_PASSWORD` → deploy env → compose interpolation                                                                                                                                                               | repo settings                      |

### Resource-Reach — verified

| RR pointer                                                                                                                                      | Access                                  | Role                             |
| :---------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------- | :------------------------------- |
| `src/pg-client.ts` (new), `src/mcp/{backend,migrate}.ts`, `compose.yaml`, `.forgejo/workflows/deploy.yml`, `docs/body-facet.md`, `package.json` | write                                   | the carve                        |
| `graph:chaos` moirae `hasPart` facets                                                                                                           | read (migration) → retract (final step) | the facet leaving Chaos          |
| `container:calliope-db` (new, nas01)                                                                                                            | create                                  | the sovereign store              |
| `container:calliope-mcp`                                                                                                                        | redeploy                                | the cutover                      |
| `src/mcp/{tools,server,http}.ts`                                                                                                                | read-only                               | pure over BodyClient — untouched |

## Data model

`sections` (the sovereign body store — the ONLY schema change anywhere):

| column      | type                 | notes                                                           |
| :---------- | :------------------- | :-------------------------------------------------------------- |
| id          | text PK              | 64-hex; migration preserves existing ids; new ids sha256-minted |
| node_id     | text NOT NULL        | the owning node (work node, prose note — any)                   |
| text        | text NOT NULL        | the section prose                                               |
| order_key   | text NOT NULL        | fractional key; reads `ORDER BY order_key COLLATE "C"`          |
| authored_by | text NOT NULL        | `human` \| `calliope` (provenance invariant)                    |
| active      | boolean NOT NULL     | current-version flag                                            |
| supersedes  | text NULL            | copy-on-write lineage (edit chains)                             |
| created_at  | timestamptz NOT NULL |                                                                 |

Index: `(node_id, order_key COLLATE "C") WHERE active`.

## Decision Log

| Decision                  | Resolution                                                                                    | Rationale                                                                 | Provenance                              | Alternatives                    |
| :------------------------ | :-------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------ | :-------------------------------------- | :------------------------------ |
| Physical sovereignty      | **sovereign store NOW** — bodies migrate out of Chaos in C2                                   | Rob's gate pick; Muse pattern (Clio/Terpsichore)                          | **Rob (2026-07-04 gate)**               | staged (facet-over-Chaos first) |
| Facet boundary            | **Calliope owns ALL bodies** — work-node plan prose included; Athena consumes the verbs       | one service, one integrity model; Athena plan untouched                   | **Rob (2026-07-04 gate)**               | kind-split                      |
| Athena `hasBody` literals | out of facet — a graph scalar on section-nodes, planning tenant's; flagged as a naming hazard | different mechanism + different grain; renaming is Athena-lane            | Claude (surfaced in docs/body-facet.md) | pull into facet now             |
| Store                     | pgvector/pg17, own compose service + private net                                              | C4 wants embeddings; enforcement by construction (network isolation)      | Claude (placement row said pgvector)    | plain postgres · tofu fleet     |
| Deploy lane               | repo-CI compose (existing lane) + Actions secret; bws is secret-of-record                     | the star already deploys this way; tofu adoption is a separate initiative | Claude                                  | move star to tofu fleet         |
| Migration locus           | one-shot command in the built image, run on nas01 east-west                                   | chaos + db are internal-only; runs where the data lives                   | Claude                                  | workstation over hades          |
| Id preservation           | migrate ids verbatim; new ids 64-hex sha256(node,text,key,nonce)                              | consumers see no format change; in-flight refs stay valid                 | Claude                                  | fresh uuids                     |
| Retraction timing         | last step of C2, after parity + live verify                                                   | Rob chose sovereign-now; bounded in-feature, not deferred                 | Rob (gate) + Claude (ordering)          | soak-days first                 |
| Write quiesce             | migration idempotent re-run until clean pass (re-copy on hash drift); no service downtime     | single-author system; writes are rare; parity gate arbitrates             | Claude                                  | maintenance window              |

## Dependencies

- PgBodyClient (T001) → backend/compose wiring (T002) → migration+parity (T003) → cutover+retraction+probe (T004). Strictly sequential.

## Impact

| Slice                        | Impact (0–10)                                                             |
| :--------------------------- | :------------------------------------------------------------------------ |
| PgBodyClient + schema        | 8 — every body consumer rides it                                          |
| Deploy wiring (db + secret)  | 6                                                                         |
| Migration + parity           | 8 — the board's live prose moves                                          |
| Cutover + retraction + probe | 9 — the point of no return (with parity + lineage as the rollback record) |

## Open & risk

- **Rollback**: after retraction, Chaos no longer holds bodies. Mitigation: the migrator writes a full JSON export artifact (`migration-export-{ts}.json` — every node's sections) to the nas01 host bind before retraction; retraction runs only after SC-001/2/5 pass.
- **COLLATE "C"** must match the substrate's ordering exactly — the parity gate would catch any divergence (it compares ordered lists).
- **The tethys password rake** (fleet memory): compose interpolation with an ABSENT env var ships the literal `${CALLIOPE_DB_PASSWORD}` — the deploy step must fail-fast if the secret is unset (guard line in deploy.yml).
- **`appendSection`** is composed in tools.ts over the BodyClient — verified pure; no extra client method needed beyond the three.

---

DoR: [x] gate decisions bound as decided · [x] contracts shaped/pinned · [x] RR verified · [x] no cycles · [x] constitution I–V hold (parity/probe make conformance observable; the one irreversible step is gated behind three observable criteria + an export artifact).
