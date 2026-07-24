# @forge/calliope — the prose/body-facet constellation star

Calliope stores and serves node **bodies** — ordered prose sections — behind
an MCP server. It is the peer of `clotho` (the work/graph facet): clotho owns
graph structure (`parent`, `dependsOn`, `status`, …); Calliope owns every
body, prose notes and work-node plan prose alike [Rob, 2026-07-04].

**The Muse shed its UI (2026-07-04).** Through spec `001-muse-sheds-ui`, the
ProseMirror editor component that used to live here moved to `@forge/aglaia`.
This repo is now service-only: the body-model types, three body-store
backends (`pg`/`hades`/`urania`, plus an in-memory `fixture` for tests), and
an MCP server exposed over stdio and streamable-HTTP. If you're looking for
the editor UI, it's in `aglaia`.

**The repo is a turbo monorepo (2026-07-10).** Adopted onto the
`frontend-repo-template` (`chore/adopt-frontend-template`, flat → monorepo):
the package now lives at `apps/calliope/` (workspaces: `apps/*`, currently
just this one app; `packages/*` is reserved by the template, unused so far).
Root `package.json` scripts (`lint`/`typecheck`/`test`/`build`) delegate to
`turbo run <task>`, which fans out to each workspace's own script. All `src/`
paths below are relative to `apps/calliope/`, not the repo root.

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
- `apply_section_ops(node_id, ops)` — A11: apply an add/update/delete/reorder
  batch in ONE transaction (all-or-nothing); a stale `section_id` rejects the
  whole batch (`stale_section`, the compare-before-write race backstop)
- `read_body_revisions(node_id, limit?)` — A8: list a body's stored
  write-events (copy-on-write lineage), newest first
- `read_body_at(node_id, revision)` — A8: reconstruct a body as of a
  `read_body_revisions` write-event

Registered when the backend supplies a document store (C3, the dissolved
vault-note archive strangled off `phdb`):

- `write_document(source_path, body_text, …)` — dedup on `(source_path, raw_hash)`
- `read_documents(id | source_path | list)`
- `read_plan(document | source_path, block?, omit_body?)` — C7: resolve a
  plan document BY REFERENCE and serve it block-granular (feature blocks
  addressed by id, e.g. `C7`), so a prose→graph consumer (athena
  `orchestrate_plan`) never loads the whole `plan_text` into context; misses
  are structured (`document_not_found` / `block_not_found`), never thrown

Registered when the backend supplies a revision store (C4, the frozen
git-for-ideas archive re-homed from `phdb`):

- `file_revisions(id | file_path | repo | list)`
- `revision_deltas(revision_id)` — the frontmatter/link delta record for one revision

## Transports

Two bins, same server (`src/mcp/server.ts`, four-to-nine tools depending on
which facet stores the backend supplies), reused unforked:

- **`calliope-mcp`** (`src/mcp/main.ts`) — stdio, for local/CLI use.
- **`calliope-mcp-http`** (`src/mcp/http.ts`) — streamable-HTTP, `POST /mcp`
  on `$PORT` (else `$CALLIOPE_MCP_PORT`, else `8204`). Stateless: a fresh
  server+transport per request over a long-lived backend. This is the
  constellation-star form — the Hades MCP gateway fronts it east-west at
  `http://calliope-mcp:8204/mcp`.

## Deploy (nas01 star)

**Deploy is no longer local to this repo.** The repo used to ship its own
`compose.yaml` + `.forgejo/workflows/deploy.yml`; both are retired
("services lane owns deploy now" / "state lives in the services lane") —
there is no `infra/` and no local `deploy.yml` here anymore. What remains in
this repo:

- `Dockerfile` — the image build only (see below), no deploy step.
- `star.toml` — the conformance target the shared admission gate reads
  (image ref, entrypoint `apps/calliope/src/mcp/http.ts`, the governance
  policy bundle). **Derived by the Hephaestus foundry — do not hand-edit.**
- `.forgejo/workflows/build.yml` — a caller stub (`push` to `main`,
  non-docs/non-infra paths) delegating to the shared, language-agnostic
  `foundry/foundry-stocks` reusable build workflow (`docker build .`, the
  Dockerfile does the rest).
- `.forgejo/workflows/ci.yml` — a caller stub (on `pull_request`) delegating
  to the shared `frontend-ci.yml` reusable workflow (bun install + `bun run
  gate` + audit + opengrep).

The image itself: `oven/bun`-based multi-stage build on
`stellar_core:bun-mcp` (digest-pinned, not a floating tag); the runtime stage
ships only the `bun build --target=bun`-bundled `server.js` — **no source
tree, no `node_modules`, no `bun install`** in the deployed image (see
Dockerfile). Publish/sign/scan/deploy mechanics now live in the shared
foundry-stocks workflows and the services-lane deploy pipeline, not in this
repo — read `star.toml` + the two `.forgejo/workflows/*.yml` caller stubs for
what this repo actually controls, not this README, if those diverge.

## Project structure

Turbo monorepo root — the package lives under `apps/calliope/`:

```
apps/calliope/
  src/
    types.ts              Section / SectionInput / BodyClient contract, BlockOp side-channel types
    index.ts              public package exports (@forge/calliope) — Urania + Fixture
                           backends only; PgBodyClient is mcp-internal, not re-exported
    order-key.ts           fractional order-key scheme (COLLATE "C")
    fixture-client.ts      FixtureBodyClient — in-memory, dev/test
    urania-client.ts       UraniaBodyClient — substrate-triple body model over an injected capture transport
    pg-client.ts           PgBodyClient — the sovereign-store backend (calliope-db `sections` table)
    document-store.ts      DocumentStore (C3) — dissolved vault-note archive
    revision-store.ts      RevisionStore (C4) — git-for-ideas archive (metadata only; blobs stay in the vault's git repo)
    plan-blocks.ts          Plan block-addressing (C7) — parses `### FN — Title · Size`
                           feature headings into addressable blocks; pure, no I/O
    mcp/
      backend.ts           env -> BackendKind -> BodyClient (+ document/revision stores)
      server.ts            createServer() — registers the MCP tools on a BodyClient
      tools.ts             tool handler functions (pure functions of a BodyClient)
      main.ts              calliope-mcp bin (stdio)
      http.ts              calliope-mcp-http bin (streamable-HTTP, :8204)
      hades-capture.ts     HadesCapture — gateway-auth transport (CHARON_URL)
      live-capture.ts      LiveUraniaCapture — direct chaos/urania engine transport
      index-push.ts        IndexingBodyClient — write-side push of assembled body prose
                           to urania's similarity index (best-effort; never fails the write)
      backfill-index.ts    one-off CLI: backfill the similarity index for bodies that
                           predate the write-side push
      heartbeat.ts         op-contract heartbeat publisher -> Pontus (`calliope._ops.heartbeat`)
      plan-ingest.ts       read_plan (C7): resolve a plan by reference, serve block-granular
      migrate.ts           C2: chaos body-facet -> calliope-db carve + retraction
      migrate-documents.ts    C3: phdb history.documents -> calliope documents
      migrate-revisions.ts    C4: phdb file_revisions/revision_triple_deltas -> calliope revisions
      migrate-dissolution-archive.ts   C5: archive the retired dissolution-bridge tables
  __tests__/               vitest specs, one per src module (22 files)
docs/body-facet.md         C2 ownership/definition record
specs/                     spec-kit feature specs, one per cut (001-005 have spec dirs;
                           later cuts — A8, A11, B, C7 — shipped docstring-only, no spec-kit dir)
rules/sast/dataflow.yml    opengrep taint ruleset (CI SAST gate)
turbo.json, tsconfig.base.json   monorepo build/typecheck orchestration
Dockerfile                 image build only — deploy itself is out-of-repo (see Deploy)
```

## Develop

From the repo root (turbo fans out to the one workspace, `apps/calliope`):

```sh
bun install
bun run lint         # turbo run lint       -> eslint .
bun run typecheck    # turbo run typecheck  -> tsc --noEmit
bun run test         # turbo run test       -> vitest run
bun run format       # prettier --write "**/*.{ts,tsx,json,css}"
bun run format:check
bun run gate         # format:check && turbo run lint typecheck test build
```

Or from `apps/calliope/` directly (same scripts, plus dev/run):

```sh
bun run test:watch   # vitest
bun run start        # calliope-mcp over stdio
bun run start:http   # calliope-mcp-http, :8204
bun run dev          # bun run --watch src/mcp/http.ts
bun run build        # bun build src/mcp/http.ts --target=bun --outfile dist/server.js
```

bun runs the TypeScript directly in dev/test — no build step, no `dist/`,
until you explicitly `bun run build` (or the Dockerfile does, for the
deployed image). Requires Node >=22.13 (`.nvmrc`: 22) and the pinned
`bun@1.3.14` (`packageManager` in the root `package.json`).

## Status

Version `0.1.0`, Apache-2.0, single-author (Rob Fischer). Early/mid-build:
the sovereign-store carve (C2), document strangle (C3), revision re-home
(C4), and dissolution-bridge archival (C5) are live. Since then: the
block-grain transactional write (`apply_section_ops`, A11), body-revision
history reads (`read_body_revisions`/`read_body_at`, A8), the write-side
similarity-index push (`index-push.ts`, B), the op-contract heartbeat
publisher, and the by-reference block-addressable plan read (`read_plan`,
C7 — the most recent cut) have all shipped. The repo was also restructured
onto the `frontend-repo-template` as a turbo monorepo (`apps/calliope/`) and
its local deploy pipeline (`compose.yaml` + `deploy.yml`) was retired in
favor of the shared services-lane deploy. See `specs/*/spec.md` for the
001-005 acceptance criteria and `docs/body-facet.md` for the standing
ownership decision; later cuts are docstring-documented only (no spec-kit
dir).
