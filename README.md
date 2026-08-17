# @forge/calliope — the prose/body-facet constellation star

Calliope stores and serves node **bodies** behind an MCP server — since
the Git for Ideas arc (2026-08-16), as **git's factoring**: immutable
content-deduped blobs in Calliope's own Postgres, tree/commit/history as
facts in the `chaos` graph, one save = one transaction, history = a read
at an earlier transaction. It is the peer of `clotho` (the work/graph
facet): clotho owns graph structure (`parent`, `dependsOn`, `status`, …);
Calliope owns every body, prose notes and work-node plan prose alike
[Rob, 2026-07-04]. The same engine ships twice: the fleet star, and the
Grace desktop sidecar running a bundled PostgreSQL + the real chaosstore
binary (baby chaos, F13).

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

## Body model — the blob store and the tree (Git for Ideas, 039–047)

**Since 2026-08-16 the store IS git's factoring** (specs `039`–`047`, the
Git for Ideas master-plan (vault), all fourteen features landed in one arc):

- **Blobs** (`apps/calliope/src/blob-store.ts`, table `blobs` in
  calliope-db): immutable, content-deduped prose — `id bigint identity,
  text`, identity enforced by a unique expression index over an
  IMMUTABLE sha256 wrapper (`blob_content_hash`). Mint returns the
  existing id on a duplicate; identical prose anywhere in the system is
  ONE row.
- **The tree** (facts in the `chaos` graph, per-tenant): a container node
  holds `tree_member` edges to kind-`Block` slot nodes; each slot holds a
  fractional `tree_position` literal and a `tree_content` edge into the
  blob store (chaos's third object domain, `o_blob`). Container+position
  is identity — an edit repoints ONE slot, a reorder rewrites ONE
  position.
- **A save is one commit** (`container-write.ts`): the client computes the
  op batch (aglaia's diff), blobs mint first, and the surviving tree
  facts ride a single admitted graph transaction. Byte-identical content
  nets out — a save whose ops all net to nothing writes nothing.
- **History is not a feature** (`container-read.ts` + chaos's `history`
  verb): every save carries a transaction id, so any past state is the
  same tree read with `as_of_tx`, and the history listing is the graph's
  own transaction log. No revision tables.
- **Blob GC** (`blob-census.ts`): an inverted census — chaos reports the
  LOG of blob ids each tenant graph has ever named (`held_blobs`),
  calliope reaps only on a complete roster of reports, mark-and-sweep
  across two complete censuses.

The old model — the `sections` table with copy-on-write lineage,
`supersessions`, `comments_on` — was **migrated (7,416 containers, full
two-sided parity; report at `specs/043-migrate-tree/parity-report.json`)
and then dropped from production** (the gated cut, spec `047`). A fresh
install bootstraps the blob store only; the legacy DDL exists solely
behind `ensureSchema({ legacy: true })`, which the migration suite uses to
simulate an old store. `src/order-key.ts` still mints the fractional
position keys (`COLLATE "C"`, compared as raw bytes).

## Backends

Backend selection (`src/mcp/backend.ts`) reads the environment, in order:

| `CALLIOPE_MCP_BACKEND` | Condition | Client | Store |
|---|---|---|---|
| `pg` | `DATABASE_URL` set (or explicit) | `PgBodyClient` | sovereign store `calliope-db` — **the default in production** |
| `hades` | `CALLIOPE_WRITE_VIA_HADES=1` / `CHARON_URL` set (or explicit) | `UraniaBodyClient` + `HadesCapture` | gateway-auth path; writes carry `authored_by=human` |
| `urania` | fallback | `UraniaBodyClient` + `LiveUraniaCapture` | direct `chaos`/`urania` engine service (`CHAOS_URL`, legacy `URANIA_URL`) — migration reads only, post-C2 |
| `fixture` | explicit only | `FixtureBodyClient` | in-memory — dev/test |

The `pg` and `fixture` backends additionally provide a **document store**
(C3, the internal dissolve sink — its verbs retired in F12), a **revision
store** (C4), and the **container facet** (blobs + the chaos dial — the
write path) off the same pool/memory; the substrate-direct backends
(`urania`, `hades`) do not. Both fleet entries pass the container facet to
the server explicitly (an F12 audit finding: it was wired in the backend
since F4 but served by neither entry until the cut — the production-shape
regression pin in `__tests__/mcp-http.test.ts` keeps it that way).

**The desktop is its own backend** (F13/F14, specs `045`/`046`): the Grace
sidecar (`src/mcp/sidecar.ts`) boots a bundled PostgreSQL + the real
`chaosstore` binary (`src/mcp/babychaos.ts`) and serves everything from
ONE `LocalEngineStore` (`src/local-store.ts`) — node identity is the
markdown path, the container is the graph node labelled by it, the
markdown directory is a projected WORKING TREE (external edits ingest
like `git add`), and admits translate in-process without themis
(`src/local-admit.ts`, a port of go-court ToWire held by the court's own
pinned constants). Payloads are assembled by
`scripts/fetch-babychaos-payload.ts` (zonky embedded-postgres + a go
build of chaosstore, linux and windows).

## MCP tools — the post-cut surface (F12)

The fleet serves **sixteen verbs**, pinned (names AND annotations) by an
executable fence in `__tests__/mcp-http.test.ts` — change the surface only
alongside the plan that licenses it:

The container surface (the ONE write path):

- `write_container(container, ops, tenant?)` — the tree-native save: one
  graph transaction, blob-first, identical content nets out
- `read_container(container, as_of_tx?)` — ordered blocks (slot, position,
  blobId, text); dangling blobs surfaced, never fabricated
- `container_history(container)` — the container's transactions (history
  IS the graph)
- `blob_census()` — the F7 GC (roster-gated mark-and-sweep)

The note-native verbs (C8/F10): `create_note`, `dissolve_note`,
`export_note`, `materialize_note`. Findability: `search`, `list_tags`,
`list_by_tag`, `copy_reference`. Attention: `look`, `unpin`. The frozen
git-for-ideas archive (read-only): `file_revisions`, `revision_deltas`.

**Retired by the F12 cut (2026-08-16)** — the body family (`read_body`,
`write_body`, `has_body`, `read_body_revisions`, `read_body_at`), the
section family (`apply_section_ops`, `append_section`, `edit_section`),
the block family (`create/read/update/delete/split/merge_block`,
`list_blocks`, `coalesce_block_writes`), the document/plan verbs
(`write_document`, `read_documents`, `read_plan`), and the comments pair.
Charon's `/body` allowlist moved with the surface; the fleet-wide caller
sweep ran first (theia's clients were repointed in the same feature).

**The desktop exception**: the sidecar's loopback `/mcp` additionally
serves path-addressed body verbs (`read_body`/`write_body`/
`apply_section_ops`/`read_body_revisions`/`read_body_at`/`has_body`)
behind the `pathBodies` server option ONLY it passes — those are the F14
engine-backed surface sharing the old wire spellings, not the old model.

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
    types.ts              Section / SectionInput / BodyClient contract (capability
                           methods REQUIRED since the F14 interface collapse)
    index.ts              public package exports (@forge/calliope)
    order-key.ts           fractional order-key scheme (COLLATE "C")
    blob-store.ts          BlobStore / FixtureBlobStore / PgBlobGc — F1/F7
    tree.ts                tree vocabulary + slot op builders + readTree — F3
    container-write.ts     writeContainer: ops -> blobs -> ONE admit — F4
    container-read.ts      readContainer (HEAD / as-of) + containerHistory — F5
    blob-census.ts         the inverted-census GC — F7
    chaos-client.ts        ChaosDial (Live/Fixture) — the graph wire
    local-admit.ts         LocalChaosDial — themis-free desktop admit (F13)
    local-store.ts         LocalEngineStore — the desktop backend: engine +
                           working-tree projection/ingestion + tags + FTS (F14)
    search-types.ts        the search seam types (SearchProvider et al.)
    eros-provider.ts       the fleet's search arm (eros-routed)
    fixture-client.ts      FixtureBodyClient — in-memory, dev/test
    urania-client.ts       UraniaBodyClient — substrate-triple mapping (legacy reads)
    pg-client.ts           PgBodyClient — blob-store DDL; the legacy sections DDL
                           only behind ensureSchema({legacy: true}) (migration suite)
    document-store.ts      DocumentStore (C3) — the internal dissolve sink
    revision-store.ts      RevisionStore (C4) — frozen archive, read-only
    plan-blocks.ts         plan block-addressing (C7; its verb retired in F12)
    mcp/
      backend.ts           env -> BackendKind -> BodyClient + facet stores
      server.ts            createServer() — the 16-verb fleet surface;
                           pathBodies option adds the desktop's body dialect
      tools.ts             tool handler functions (pure over a BodyClient)
      main.ts              calliope-mcp bin (stdio)
      http.ts              calliope-mcp-http bin (streamable-HTTP, :8204)
      sidecar.ts           the Grace desktop sidecar — engine-backed (F13/F14)
      babychaos.ts         payload resolve + engine boot/stop (F13)
      drop-old-tables.ts   the F12 gated drop (parity report + frozen-store check)
      migrate-tree.ts      the F6 migration engine (retry armor, crash recovery,
                           carrier fallback) — the old store's replay
      index-push.ts        IndexingBodyClient — similarity-index push decorator
      backfill-index.ts    one-off index backfill CLI
      heartbeat.ts         op-contract heartbeat -> Pontus
      hades-capture.ts / live-capture.ts   legacy substrate transports
      migrate.ts / migrate-documents.ts / migrate-revisions.ts /
      migrate-dissolution-archive.ts       the C2-C5 era migrations (historical)
  scripts/
    fetch-babychaos-payload.ts   assemble the desktop engine payload (F13)
  __tests__/               vitest specs (49 files; engine suites gated on
                           CALLIOPE_BABYCHAOS_DIR / CALLIOPE_CHAOSSTORE_BIN)
docs/body-facet.md         C2 ownership record (historical; superseded by 039-047)
specs/                     spec-kit feature dirs — 039-047 are the Git for Ideas
                           arc; 043 carries the production parity report
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

Version `0.1.0`, Apache-2.0, single-author (Rob Fischer). **The Git for
Ideas arc is complete (2026-08-16, specs `039`–`047`)**: the blob store
(F1), the tree + container write/read/history (F3–F5), blob GC (F7), the
ferry + editor + consumer repoints (F8–F11), the full production
migration to two-sided parity (F6 — 7,416 containers, report archived in
`specs/043-migrate-tree/`), the desktop engine (F13 baby chaos), the
deletion of the parallel fs implementation (F14), and the cut (F12 — the
old verb families retired and `sections`/`supersessions`/`comments_on`
dropped from production behind the gated tool). The C2–C5/A8/A11/C7 era
described in `docs/body-facet.md` and the older spec dirs is historical
context: its storage model and most of its verb surface no longer exist.
