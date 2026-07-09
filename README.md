# @forge/calliope — the prose/body-facet constellation star

Calliope stores and serves node **bodies** — ordered prose sections — behind
an MCP server. It is the peer of `clotho` (the work/graph facet): clotho owns
graph structure (`parent`, `dependsOn`, `status`, …); Calliope owns every
body, prose notes and work-node plan prose alike [Rob, 2026-07-04].

**The Muse shed its UI (2026-07-04).** Through spec `001-muse-sheds-ui`, the
ProseMirror editor component that used to live here moved to `@forge/aglaia`.
This repo is now service-only: the body-model types, two service backends,
and an MCP server exposed over stdio and streamable-HTTP. If you're looking
for the editor UI, it's in `aglaia`.

## Body model

A node's body is its ordered list of sections — `(text, order_key)` pairs
with copy-on-write version lineage. Sections sort by `order_key`, compared as
raw bytes (`COLLATE "C"`), never numerically; `src/order-key.ts` mints
fractional keys so inserts never require renumbering.

Storage moved off the shared graph substrate into Calliope's own database
(`calliope-db`, Postgres + pgvector) as of spec `002-facet-carve-sovereign-store`
(C2, 2026-07-04) — the "facet carve." A single `sections` table
(`node_id, id, text, order_key, authored_by, active, supersedes`) holds
current + superseded versions; a coarse save mints a fresh key sequence and
deactivates prior rows, a single-section edit copy-on-writes just that row.
The legacy substrate-triple model (`note --hasPart--> section --text/order_key-->`,
in the `chaos`/`urania` graph engine) is preserved only as a read path for
migration and as the shape `UraniaBodyClient` still speaks — see
`docs/body-facet.md` for the ownership decision record.

## Backends

Backend selection (`src/mcp/backend.ts`) reads the environment, in order:

| `CALLIOPE_MCP_BACKEND` | Condition | Client | Store |
|---|---|---|---|
| `pg` | `DATABASE_URL` set (or explicit) | `PgBodyClient` | sovereign store `calliope-db` — **the default in production** |
| `hades` | `CALLIOPE_WRITE_VIA_HADES=1` / `CHARON_URL` set (or explicit) | `UraniaBodyClient` + `HadesCapture` | gateway-auth path; writes carry `authored_by=human` |
| `urania` | fallback | `UraniaBodyClient` + `LiveUraniaCapture` | direct `chaos`/`urania` engine service (`CHAOS_URL`, legacy `URANIA_URL`) — migration reads only, post-C2 |
| `fixture` | explicit only | `FixtureBodyClient` | in-memory — dev/test |

The `pg` and `fixture` backends additionally provide a **document store** (C3)
and a **revision store** (C4) off the same pool/memory; the substrate-direct
backends (`urania`, `hades`) do not.

## MCP tools

Always registered (the body facet):

- `read_body(node_id)` — sections sorted by `order_key`
- `write_body(node_id, sections)` — coarse-save (replace the whole body)
- `append_section(node_id, text)` — append one section
- `edit_section(node_id, section_id, text)` — single-section copy-on-write edit

Registered when the backend supplies a document store (C3, the dissolved
vault-note archive strangled off `phdb`):

- `write_document(source_path, body_text, …)` — dedup on `(source_path, raw_hash)`
- `read_documents(id | source_path | list)`

Registered when the backend supplies a revision store (C4, the frozen
git-for-ideas archive re-homed from `phdb`):

- `file_revisions(id | file_path | repo | list)`
- `revision_deltas(revision_id)` — the frontmatter/link delta record for one revision

## Transports

Two bins, same four-to-eight-tool server (`src/mcp/server.ts`), reused unforked:

- **`calliope-mcp`** (`src/mcp/main.ts`) — stdio, for local/CLI use.
- **`calliope-mcp-http`** (`src/mcp/http.ts`) — streamable-HTTP, `POST /mcp`
  on `$PORT` (else `$CALLIOPE_MCP_PORT`, else `8204`). Stateless: a fresh
  server+transport per request over a long-lived backend. This is the
  constellation-star form — the Hades MCP gateway fronts it east-west at
  `http://calliope-mcp:8204/mcp`.

## Deploy (nas01 star)

`compose.yaml` + `Dockerfile` + `.forgejo/workflows/deploy.yml` ship the HTTP
star to nas01. Two services: `calliope-mcp` (bun runtime, no `node_modules`,
built with `bun build --target=bun`) and `calliope-db` (`pgvector/pgvector:pg17`,
private `calliope-net` — reachable by nothing but `calliope-mcp`; the
enforcement is network topology, not a policy check). `calliope-mcp` also
joins the external `mnemosyne-net` so Hades can reach it; no host port is
published.

Push to `main` (non-docs paths) runs the Forgejo Actions gate on the `nas01`
runner: format/lint/typecheck/test → `bun audit --audit-level=high` →
`opengrep` SAST (vendored taint rules, `rules/sast/`) → `docker compose build
--no-cache` → Trivy image scan (blocking on fixable HIGH/CRITICAL) → publish
to `forgejo.notusmi.com/rob/calliope-mcp` → `docker compose up -d` → cosign
sign + CycloneDX SBOM attestation, verified against the committed `cosign.pub`
→ SBOM upload to Dependency-Track. Joining the constellation is one line in
the gateway's `hades.toml` `[stars]` table + a Hades restart.

Required secrets: `REGISTRY_TOKEN`, `CALLIOPE_DB_PASSWORD`,
`COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD`, `DTRACK_API_KEY`.

## Project structure

```
src/
  types.ts              Section / SectionInput / BodyClient contract, BlockOp side-channel types
  index.ts              public package exports (@forge/calliope)
  order-key.ts           fractional order-key scheme (COLLATE "C")
  fixture-client.ts      FixtureBodyClient — in-memory, dev/test
  urania-client.ts        UraniaBodyClient — substrate-triple body model over an injected capture transport
  pg-client.ts           PgBodyClient — the sovereign-store backend (calliope-db `sections` table)
  document-store.ts      DocumentStore (C3) — dissolved vault-note archive
  revision-store.ts      RevisionStore (C4) — git-for-ideas archive (metadata only; blobs stay in the vault's git repo)
  mcp/
    backend.ts           env -> BackendKind -> BodyClient (+ document/revision stores)
    server.ts            createServer() — registers the MCP tools on a BodyClient
    tools.ts              tool handler functions (pure functions of a BodyClient)
    main.ts               calliope-mcp bin (stdio)
    http.ts                calliope-mcp-http bin (streamable-HTTP, :8204)
    hades-capture.ts       HadesCapture — gateway-auth transport (CHARON_URL)
    live-capture.ts         LiveUraniaCapture — direct chaos/urania engine transport
    migrate.ts              C2: chaos body-facet -> calliope-db carve + retraction
    migrate-documents.ts    C3: phdb history.documents -> calliope documents
    migrate-revisions.ts    C4: phdb file_revisions/revision_triple_deltas -> calliope revisions
    migrate-dissolution-archive.ts   C5: archive the retired dissolution-bridge tables
__tests__/               vitest specs, one per src module (14 files)
docs/body-facet.md       C2 ownership/definition record
specs/                   spec-kit feature specs, one per cut (001-005)
rules/sast/dataflow.yml   opengrep taint ruleset (CI SAST gate)
compose.yaml, Dockerfile  nas01 deploy (calliope-mcp + calliope-db)
```

## Develop

```sh
bun install
bun run lint         # eslint .
bun run typecheck    # tsc --noEmit
bun run test         # vitest run
bun run test:watch   # vitest
bun run format       # prettier --write
bun run format:check
bun run start        # calliope-mcp over stdio
bun run start:http   # calliope-mcp-http, :8204
```

bun runs the TypeScript directly — there is no build step and no `dist/`. A
consumer links the sources with `file:../calliope`. Requires Node >=22.13
(`.nvmrc`: 22) and the pinned `bun@1.3.14` (`packageManager` in `package.json`).

## Status

Version `0.1.0`, Apache-2.0, single-author (Rob Fischer). Early/mid-build:
the sovereign-store carve (C2), document strangle (C3), and revision re-home
(C4) are live; C5 (dissolution-bridge archival) is the most recent cut. See
`specs/*/spec.md` for the per-cut acceptance criteria and `docs/body-facet.md`
for the standing ownership decision.
