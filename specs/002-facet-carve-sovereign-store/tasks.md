---
description: "Forge work-chunks — binding, conflict-checked, executor-optimized"
---

# Tasks: C2 — the Facet Carve (Sovereign Store)

**Critical path:** T001 → T002 → T003 → T004 (strictly sequential).

### T001 — `PgBodyClient` + schema + contract tests · L

- **Acceptance:** Given a postgres with the `sections` schema (bootstrapped by `ensureSchema()`), When PgBodyClient runs readBody/saveBody/editSection, Then semantics match the substrate client: COLLATE-"C" ordering, coarse-save mints fresh order keys + deactivates priors, editSection copy-on-writes (new 64-hex id, same order_key, supersedes lineage, old row inactive), authored_by persisted per version; contract tests pass against a real ephemeral postgres (docker-run in setup; skip-if-no-docker) and the existing suite stays green.
- **Touches:** write `src/pg-client.ts`, `__tests__/pg-client.test.ts`, `package.json` (+`pg`).
- **Decisions-slice:** schema per plan Data model [decided]; id preservation shape [Claude].

### T002 — Backend `pg` + compose `calliope-db` + secret wiring · M

- **Acceptance:** Given `DATABASE_URL` set, When the service boots, Then backend kind is `pg` (explicit `CALLIOPE_MCP_BACKEND` still wins; chaos kind retained for migration); compose gains the `calliope-db` service (pgvector/pg17, `calliope-db-data` volume, private `calliope-net`) and calliope-mcp joins it with `DATABASE_URL`; deploy.yml exports `CALLIOPE_DB_PASSWORD` from the Actions secret with a fail-fast guard when unset; the password is generated, stored in bws (pantheon, `CALLIOPE_DB_PASSWORD`) and set as the repo Actions secret — never echoed.
- **Touches:** write `src/mcp/backend.ts`, `compose.yaml`, `.forgejo/workflows/deploy.yml`; call bws + Forgejo secrets API.

### T003 — Migrator + parity + export + probe · L

- **Acceptance:** Given chaos live, When `node dist/mcp/migrate.js` runs (east-west on nas01), Then it enumerates every `hasPart`-carrying subject in the moirae graph (`graph_edges`), copies each body into pg preserving section ids/text/order_key (authored_by `calliope` where the substrate records none), writes a full JSON export artifact, emits per-node parity (sha256 over ordered (order_key,text)), is idempotently re-runnable, and exits nonzero on any mismatch. `--probe` reports remaining chaos body-triple count.
- **Touches:** write `src/mcp/migrate.ts` (+ dist bin wiring), tests for hashing/idempotence over fixtures.

### T004 — Cutover + live verify + retraction · M

- **Acceptance:** Given T001–T003 merged and deployed (db up, migration parity 100%, export artifact on the host), When calliope-mcp restarts with `DATABASE_URL` (backend pg), Then the Hades round-trip (write/append/edit/read on a scratch node) is green with rows + provenance visible in pg, known projection bodies spot-check identical (SC-005), and ONLY THEN `migrate.js --retract` removes the chaos body triples, after which `--probe` reports 0 and a fresh spot-check still serves every body.
- **Touches:** deploy; run migrator + retraction on nas01; write nothing new.
- **Open:** none — the irreversible step is gated on SC-001/2/5 + export.

---

Done-when: all four tasks carry Acceptance+Touches · sequential · Exposes traces to plan · the retraction ran gated.
