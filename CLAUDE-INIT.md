Codebase orientation for AI sessions. Posture and governance live in
AGENTS.md (furnace-compiled); this file is the repo-specific map, read on
demand.

Note: `AGENTS.md` and `CLAUDE.md` now exist in this worktree — both are
furnace-provisioned (`furnace pour`) and gitignored (`.gitignore`'s
"furnace-provisioned" block), so they won't show up in a bare `git status`
or a fresh clone until poured. Don't hand-edit them; run `furnace stoke` to
regenerate. Fleet role below still leans on source + package.json where the
governance doc doesn't cover repo-specific structure.

## Overview

`@forge/calliope` is the **prose/body facet** of the Forge/Pantheon
constellation. It stores and serves node **bodies** (ordered prose sections)
behind an MCP server, and is the direct peer of `clotho`, the **work/graph**
facet — clotho owns graph structure (parent/dependsOn/status/…), Calliope
owns every body (prose notes AND work-node plan prose) [Rob's decision,
2026-07-04, recorded in `docs/body-facet.md`].

**Critical context: the Muse shed its UI on 2026-07-04** (spec
`001-muse-sheds-ui`). Before that date this repo ALSO shipped the ProseMirror
editor component (`NodeBodyEditor`). That UI moved to `@forge/aglaia`; this
repo kept only the verbs. Any doc, memory, or old commit describing Calliope
as "the editor" is describing the pre-split state — treat as historical, not
current. Current identity: service-only, `apps/calliope/src/mcp/` is the
whole product surface.

**Critical context: the repo became a turbo monorepo on 2026-07-10**
(`chore/adopt-frontend-template`, flat → monorepo). Any doc, memory, or old
commit referencing bare `src/...` paths at the repo root is describing the
pre-adoption layout — the package now lives at `apps/calliope/`; root
`package.json` only has `turbo run <task>` delegating scripts. Workspaces are
`apps/*` (just `calliope` today) and `packages/*` (reserved by the template,
unused).

Since the Muse-sheds-UI split the repo has taken on several more cuts, each
carving something out of the legacy monolith (`phdb`) onto this star, plus a
few smaller additions that never got their own spec-kit dir:

- **C2** (`specs/002-facet-carve-sovereign-store`) — bodies move off the
  shared graph substrate (`chaos`/`urania`) into Calliope's own Postgres
  (`calliope-db`). This is the current default storage.
- **C3** (`specs/003-prose-strangle-move`) — the dissolved-vault-note archive
  (`phdb history.documents`) moves here as the **document store**.
- **C4** (`specs/004-notes-and-revision`) — the frozen git-for-ideas archive
  (`phdb history.file_revisions` / `history.revision_triple_deltas`) moves
  here as the **revision store**. Capture stopped 2026-05-27; this is
  read-only history now (go-forward instrumentation is Aglaia's block-op
  stream).
- **C5** (`specs/005-dissolution-residuals.md`) — archives the now-retired
  dissolution-bridge's bookkeeping tables as frozen historical record.
- **A11** (no spec dir) — `apply_section_ops`: the block-grain transactional
  write (add/update/delete/reorder in one all-or-nothing batch).
- **A8** (no spec dir) — `read_body_revisions` / `read_body_at`: the
  copy-on-write history reads.
- **B** (no spec dir) — the write-side push of assembled body prose to
  urania's similarity index (`mcp/index-push.ts`), plus a one-off
  `mcp/backfill-index.ts` sweep for bodies that predate the push.
- **C7** (no spec dir, this branch: `feat/c7-plan-ingest-block-addressable`)
  — `read_plan`: resolve a plan document by reference and serve it
  block-granular (`plan-blocks.ts` + `mcp/plan-ingest.ts`), so athena's
  `orchestrate_plan` never loads a whole `plan_text` into context.

There's also an op-contract heartbeat publisher (`mcp/heartbeat.ts`, no
C-number) publishing this star's liveness to Pontus.

- **039–047 — GIT FOR IDEAS (2026-08-16, the current model).** The whole
  storage story above is superseded: blobs (039) + the tree in chaos
  (040) + container write/read/history (041/042) + the full production
  migration with archived parity report (043) + blob GC (044) + the
  desktop engine (045, baby chaos) + the fs-backend deletion (046) + the
  cut (047 — the old verb families retired, `sections`/`supersessions`/
  `comments_on` DROPPED from production). Read the README's "Body model"
  and "MCP tools" sections first; the C2–C7 material above is history.

## Architecture / module map

Repo root is a turbo monorepo; everything below is under `apps/calliope/`
unless marked otherwise.

```
apps/calliope/
  src/
    types.ts            Section, SectionInput, BodyClient (the transport contract),
                         BlockOp / BlockOpEmitter (append-only op-log side channel)
    index.ts            package's public export surface (@forge/calliope) — exports
                         UraniaBodyClient + FixtureBodyClient, NOT PgBodyClient (that
                         stays mcp-internal; see backend.ts)
    order-key.ts        fractional order-key scheme: between(a,b), sequence(n),
                         compareKeys() — byte-wise COLLATE "C" semantics
    fixture-client.ts   FixtureBodyClient: in-memory BodyClient, no copy-on-write
                         modeling (not observable through the contract)
    urania-client.ts    UraniaBodyClient: substrate-triple body model
                         (note --hasPart--> section --text/order_key-->) over an
                         injected UraniaCapture transport. Guarded by
                         CALLIOPE_URANIA_WIRED. Also exports SECTION_TYPE/HAS_PART/
                         TEXT/ORDER_KEY predicate constants and AuthoredBy type.
    pg-client.ts        PgBodyClient: the sovereign-store backend. One `sections`
                         table, PK (node_id, id) — NOT id alone (a section can be
                         hasPart of >1 owner; found by the C2 parity gate on 15
                         "twin owner" rows). ensureSchema() bootstraps idempotently.
    document-store.ts   DocumentStore (C3): PgDocumentStore + FixtureDocumentStore.
                         Dedup key (source_path, raw_hash); mirrors the phdb HTTP
                         /write/document wire contract verbatim so vault-mcp's
                         dissolve payloads pass through unchanged.
    revision-store.ts   RevisionStore (C4): PgRevisionStore + FixtureRevisionStore.
                         file_revisions + revision_triple_deltas, ids preserved
                         verbatim from phdb. Blob shas are POINTERS ONLY — blob
                         content lives in the vault's own git repo, never here.
    plan-blocks.ts       Plan block-addressing (C7): parsePlanBlocks()/sliceBlock()/
                         toBlockRef(). Pure — no I/O, no store. Parses feature
                         headings (`### FN — Title · Size`, depth 2-4, id token =
                         1-6 letters + digits) into addressable PlanBlocks; a block
                         runs to the next same-or-shallower heading or EOF.
    mcp/
      backend.ts         env -> BackendKind ("pg"|"hades"|"urania"|"fixture") ->
                          BodyClient (+ optional documents/revisions). backendKind()
                          and makeBackend()/makeBodyClient() are the seam every
                          entrypoint calls through. initBackend() bootstraps pg
                          schemas async, before serving. withIndexPush() wraps
                          pg/urania clients with the similarity-index push (below);
                          hades is NOT wrapped (the gateway does its own push).
      server.ts          createServer(client, options) -> McpServer. Since the
                          F12 cut the fleet surface is 16 verbs: the container
                          surface (write_container/read_container/
                          container_history, iff containers facet; blob_census
                          iff its gc) + the _note four (iff chaos facet) + tags
                          (iff tags) + search/look/unpin/copy_reference +
                          file_revisions/revision_deltas (iff revisions). The
                          path-addressed body verbs register ONLY under
                          options.pathBodies (the desktop sidecar).
      tools.ts           Pure handler functions (readBody/writeBody/
                          applySectionOps/readBodyRevisions/readBodyAt/
                          copyReference/look/unpin/createNote/tags) — the F12
                          cut deleted the block/comment/append/edit helpers;
                          the survivors serve the desktop dialect + note verbs
                          FixtureBodyClient. Each optional-capability handler
                          (editSection, applySectionOps, the revision reads)
                          throws a named "backend does not support X" error when
                          the configured BodyClient lacks the method — no silent
                          fallback.
      main.ts            calliope-mcp bin: stdio transport.
      http.ts             calliope-mcp-http bin: StreamableHTTPServerTransport,
                          stateless (sessionIdGenerator: undefined), POST /mcp
                          only (GET/DELETE not offered — no SSE, no sessions).
                          resolvePort(): PORT || CALLIOPE_MCP_PORT || 8204.
      hades-capture.ts    HadesCapture: gateway-auth transport (CHARON_URL) — the
                          F2 path; writes get authored_by="human" via the
                          gateway's SET ROLE human seam. hadesEnabled(env) gate.
      live-capture.ts     LiveUraniaCapture: direct chaos/urania engine-service
                          transport (CHAOS_URL, legacy URANIA_URL) — clotho-parity.
      index-push.ts       IndexingBodyClient (B): decorates ANY BodyClient so every
                          write also pushes the assembled prose to urania's
                          `index_document` verb. Best-effort — a push failure never
                          fails the body write; the index is derived state that
                          re-syncs on the next write or backfill-index.ts.
      backfill-index.ts   One-off CLI (B): sweeps every body-bearing node in the
                          sovereign store and pushes it to urania's index, closing
                          the gap for bodies written before the push shipped.
                          `--probe` counts only. Needs DATABASE_URL +
                          CALLIOPE_INDEX_URL (or URANIA_URL/CHAOS_URL).
      heartbeat.ts        Bun-side mirror of stellar_core.AsyncHeartbeatPublisher:
                          publishes {star,live,ready,metrics,ts} to
                          calliope._ops.heartbeat on Pontus every interval.
                          Degrades gracefully — a broker that never connects logs
                          once per beat; never throws into the request path.
      plan-ingest.ts      readPlan()/isReadPlanError() (C7): resolve a plan
                          DocumentStore row by reference (document id or
                          source_path, newest version wins), then either return
                          the block index (+ body_text unless omit_body) or slice
                          one block by id via plan-blocks.ts. Structured misses
                          (document_not_found/block_not_found/bad_handle), never
                          thrown. Registered as the read_plan tool only when a
                          documents store is present.
      migrate.ts          C2 tool: chaos hasPart-carrying subjects -> calliope-db,
                          preserving section ids/text/order_key. Modes: default
                          (migrate+parity+export), --probe (drift count only),
                          --retract (post-cutover Chaos cleanup; refuses without
                          a prior export file). Run from a checkout with
                          reachability to both stores — NOT the deployed image
                          (see Deploy below).
      migrate-documents.ts    C3 tool: phdb history.documents -> calliope
                          documents. PHDB_DATABASE_URL (source) + DATABASE_URL
                          (dest). --probe for counts/parity only.
      migrate-revisions.ts    C4 tool: phdb file_revisions +
                          revision_triple_deltas -> calliope revisions. Denormalizes
                          (subject,predicate,object) dictionary pks to labels.
      migrate-dissolution-archive.ts   C5 tool: copies dissolutions /
                          file_revision_dissolutions / materialization_events into
                          archive_*-prefixed tables. Row-count parity is the gate.
  __tests__/            vitest, one spec file per src module (22 total):
                        apply-section-ops, backend, backfill-index, body-revisions,
                        document-store, edit-section, fixture-client, hades-capture,
                        heartbeat, index-push, live-capture, mcp-documents,
                        mcp-http, mcp-plan-ingest, mcp-tools, migrate, order-key,
                        pg-client, plan-blocks, plan-ingest, revision-store,
                        urania-client.
docs/body-facet.md    C2 ownership/definition record — read this before
                       touching anything about what a "body" is or who owns it.
specs/                 spec-kit feature specs, one dir per cut (only the earliest
                       five cuts got a spec-kit dir; A8/A11/B/C7 shipped
                       docstring-only):
  001-muse-sheds-ui/            the editor-UI split (mirrors aglaia's 001-the-split)
  002-facet-carve-sovereign-store/   the pg carve (C2)
  003-prose-strangle-move/      the document strangle (C3)
  004-notes-and-revision/       the revision re-home (C4)
  005-dissolution-residuals.md  the dissolution-bridge archive (C5, spec-lite)
rules/sast/dataflow.yml   opengrep vendored taint ruleset — the CI SAST gate
turbo.json              root task graph: lint/typecheck/test depend on ^build;
                       build outputs .next/**, dist/**
star.toml                DERIVED by the Hephaestus foundry — do not hand-edit.
                       Conformance target for the shared admission gate: image
                       ref, entrypoint (apps/calliope/src/mcp/http.ts), policy bundle.
Dockerfile             multi-stage bun build on stellar_core:bun-mcp (digest-pinned);
                       manifests copied + `bun install --frozen-lockfile` BEFORE
                       source (cache-layer ordering, see the file's own comment);
                       bundles apps/calliope/src/mcp/http.ts --target=bun into
                       ONE server.js — the runtime stage ships no node_modules AND
                       no source tree; HEALTHCHECK via bun fetch against /mcp
                       (expects 405, proving the server answers).
.forgejo/workflows/build.yml   caller stub -> foundry-stocks' shared,
                       language-agnostic build workflow (push to main).
.forgejo/workflows/ci.yml      caller stub -> foundry-stocks' shared
                       frontend-ci.yml (pull_request).
```

**Retired, do not look for:** `compose.yaml` and `.forgejo/workflows/deploy.yml`
— both dropped when deploy moved to the shared services lane (2026-07,
"services lane owns deploy now"). There is no local `infra/` either.

## Entry points

- **`calliope-mcp`** bin -> `apps/calliope/src/mcp/main.ts` -> stdio MCP
  server. Run locally (from `apps/calliope/`): `bun run start` (equivalently
  `bun run src/mcp/main.ts`).
- **`calliope-mcp-http`** bin -> `apps/calliope/src/mcp/http.ts` ->
  streamable-HTTP MCP server on `POST /mcp`, port `8204` default. Run
  locally: `bun run start:http`. This is what the deployed image's bundled
  `server.js` runs (`Dockerfile` CMD) — the image does NOT run this file
  directly; it runs the `bun build --target=bun` output.
- **Library** — `apps/calliope/src/index.ts`, consumed as `@forge/calliope`
  (a source import via `file:../calliope`, no build step in dev). Exports
  the `Section`/`BodyClient` contract, the Urania and Fixture backends
  (PgBodyClient is NOT re-exported — mcp-internal only, reached via
  `mcp/backend.ts`), `order-key` helpers, and the C3/C4 store classes.
- **Migration + ops CLIs** — the four `mcp/migrate*.ts` scripts plus
  `mcp/backfill-index.ts`, each a standalone `bun run src/mcp/<name>.ts
  [--probe|--retract]` invocation. Run from a checkout with network
  reachability to the needed stores (`DATABASE_URL` always; `PHDB_DATABASE_URL`
  for C3/C4/C5; `CALLIOPE_INDEX_URL`/`URANIA_URL`/`CHAOS_URL` for the
  backfill) — **not** the deployed runtime image, which ships only the
  bundled `server.js` with no source tree and no `bun install`.

## Build / Test / Run

From the repo root, `package.json` scripts delegate to `turbo run <task>`,
which fans out to the one workspace (`apps/calliope`); bun runs TypeScript
directly in dev/test, no build step, no `dist/` until `bun run build`:

```sh
bun install                # deps (packageManager: bun@1.3.14, engines.node >=22.13)
bun run lint                # turbo run lint -> eslint . (strictTypeChecked + stylisticTypeChecked)
bun run typecheck           # turbo run typecheck -> tsc --noEmit
bun run test                # turbo run test -> vitest run
bun run format              # prettier --write "**/*.{ts,tsx,json,css}" — .md excluded (see prettierignore/CI note below)
bun run format:check
bun run gate                # format:check && turbo run lint typecheck test build
```

From `apps/calliope/` directly: `bun run test:watch` (vitest), `bun run
start` (calliope-mcp, stdio), `bun run start:http` (calliope-mcp-http,
:8204), `bun run dev` (`--watch` http.ts), `bun run build` (bundles
http.ts to `dist/server.js`).

Local dev backend defaults to `urania`/`chaos` reads unless you set
`CALLIOPE_MCP_BACKEND=fixture` (safe, in-memory) or `DATABASE_URL` (real
`pg` backend, needs a reachable `calliope-db`). Tests drive
`FixtureBodyClient`/`FixtureDocumentStore`/`FixtureRevisionStore` — no live
network or DB needed to run `bun run test`.

CI is two Forgejo Actions caller stubs, NOT a local `deploy.yml` (that file
is retired — deploy now lives in the shared services lane, out of this
repo): `.forgejo/workflows/ci.yml` (on `pull_request`) delegates to
foundry-stocks' `frontend-ci.yml` (bun install + `bun run gate` + audit +
opengrep); `.forgejo/workflows/build.yml` (push to `main`, non-docs/non-infra
paths) delegates to foundry-stocks' language-agnostic build workflow
(`docker build .`). Publish/sign/scan/deploy mechanics live in those shared
workflows, not here.

## Conventions and gotchas

- **Bun, not Node, at runtime.** The Dockerfile builds with `oven/bun` and
  ships a single bundled `server.js` via `bun build --target=bun`; there is
  no `node_modules` in the image. Locally, `bun run <script>` is the only
  supported invocation — don't reach for `npm`/`node` directly.
- **`order_key` compares as raw bytes, `COLLATE "C"`, never numerically.**
  Every store (`sections` SQL index, `UraniaBodyClient`, `FixtureBodyClient`)
  must sort this way; `src/order-key.ts`'s `compareKeys`/`sequence`/`between`
  are the single source of that semantics — don't reimplement key comparison
  ad hoc.
- **Section identity is a placement id, not a content hash.** Two sections
  with identical prose are still two distinct `id`s. Content-addressing of
  the *text* literal itself was the substrate's job (pre-C2); `PgBodyClient`
  mints ids via `sha256(nodeId + text + orderKey + random nonce)` — collision-safe,
  not content-derived.
- **`sections` PK is `(node_id, id)`, not `id` alone.** A section can be
  `hasPart` of more than one owner (a node and its content-hash "twin"); an
  id-only PK silently drops twin-owner rows on read. This was found live by
  the C2 parity gate (15 affected owners) — don't "simplify" the PK back to
  `id` alone.
- **The BodyClient capability methods are REQUIRED since F14** (the
  interface collapse): `editSection`/`applySectionOps`/`readRevisions`/
  `readRevisionAt`/`hasBody` lost their `?` and every surviving client
  implements them (the fs backend, which couldn't, is deleted). Only the
  F12-bound five (`splitSection`/`mergeSections`/`coalesceArc`/
  `createComment`/`listComments`) stay optional with guards — their verbs
  are gone from every surface.
- **`CALLIOPE_URANIA_WIRED` gates the live substrate transport** inside
  `UraniaBodyClient`; `backend.ts` sets it on for both live substrate
  backends (`urania`, `hades`) — if you construct a `UraniaBodyClient`
  directly outside that factory, you must set the flag yourself or writes
  silently no-op.
- **`CHAOS_URL` is legacy-`URANIA_URL`-compatible** — both env vars are
  honored for the same setting throughout (`backend.ts`, `live-capture.ts`).
  Post-C2, this path is migration/retraction reads ONLY; the serving path is
  `pg`.
- **Migration scripts are idempotent and parity-gated**, not fire-and-forget:
  each does per-row/per-node hash comparison between source and destination
  and exits nonzero on mismatch. `--retract` (C2 only) refuses to run without
  a prior successful export file — read the script header before invoking a
  flag you haven't used before.
- **Athena's `hasBody` literal is NOT a Calliope body.** `docs/body-facet.md`
  flags this explicitly: `revise_section_node` can write a `hasBody` literal
  on planning-graph section-nodes — a different mechanism, different grain,
  no section tree. Don't conflate the two when reasoning about "who owns
  this prose."
- **The old `compose.yaml`-based deploy is retired** (see the Deploy note at
  the end of the module map) — deploy secrets/interpolation guards for
  `calliope-db`'s password now live in the shared services-lane pipeline,
  not in this repo. Don't go looking for a local `docker compose up` guard;
  it isn't here anymore.
- **`eslint.config.mjs` ignores `**/*.config.*`** including itself and
  `vitest.config.ts` — don't expect lint to catch issues in those files.
- `AGENTS.md`/`CLAUDE.md` DO exist in this worktree (furnace-poured,
  gitignored) — see the top-of-file note. A fresh clone won't have them
  until `furnace pour` runs.

## Related repos

- **`aglaia`** — received the editor UI in the 2026-07-04 split
  (`@forge/aglaia`); its `specs/001-the-split` mirrors this repo's
  `001-muse-sheds-ui`. Also the source of the go-forward block-op
  self-instrumentation stream that supersedes the retired writing-delta
  analytics.
- **`clotho`** — the work/graph facet (board CRUD on nodes), a Python stack,
  Calliope's direct peer. Tool shapes here (read/write/append/edit) mirror
  clotho's conceptually, not its implementation.
- **`tantalus`** — the render surface for clotho's graph; imports the
  (now-Aglaia) editor for body text and/or calls Calliope's MCP tools.
- **`urania`/`chaos`** — the shared graph-substrate engine service. Pre-C2,
  the only home for bodies; post-C2, migration/retraction-read-only for the
  body model itself, PLUS a new write relationship since B: Calliope's
  `index-push.ts` pushes assembled body prose to urania's `index_document`
  verb on every write (best-effort; urania re-embeds without decoding the
  section model).
- **`athena`** — the planning-graph facet; a consumer of Calliope's body
  verbs (`revise_section_node`), the owner of the unrelated `hasBody`
  literal (see gotchas), AND (since C7) the caller of `read_plan` —
  `orchestrate_plan` takes a plan by reference (a `PlanHandle`) instead of
  loading the whole `plan_text` into its context.
- **`vault-mcp`** — the vault write-gate; its dissolve path is the one live
  caller of `write_document` (step 2, `/dissolution/declare`, C5).
- **`phdb`** — the legacy monolith being strangled. `history.documents`
  (C3), `history.file_revisions`/`history.revision_triple_deltas` (C4), and
  the dissolution-bridge tables (C5) all migrate FROM phdb INTO Calliope;
  each migration's corresponding phdb CLI/MCP surface is deregistered after
  parity is confirmed.
- **Hades** — the MCP gateway that fronts every constellation star
  east-west, including `calliope-mcp` at `http://calliope-mcp:8204/mcp`
  (config: the gateway's own `hades.toml` `[stars]` table, not in this repo).
