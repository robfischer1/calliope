Codebase orientation for AI sessions. Posture and governance live in
AGENTS.md (furnace-compiled); this file is the repo-specific map, read on
demand.

Note: this repo has no `AGENTS.md`/`CLAUDE.md` of its own in this worktree —
the fleet-level governance that normally layers on top isn't present here.
Fleet role below is inferred from source + package.json, not read from a
governance doc.

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
current. Current identity: service-only, `src/mcp/` is the whole product
surface.

Since then the repo has taken on three more cuts, each carving something out
of the legacy monolith (`phdb`) onto this star:

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

## Architecture / module map

```
src/
  types.ts            Section, SectionInput, BodyClient (the transport contract),
                       BlockOp / BlockOpEmitter (append-only op-log side channel)
  index.ts            package's public export surface (@forge/calliope)
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
  mcp/
    backend.ts         env -> BackendKind ("pg"|"hades"|"urania"|"fixture") ->
                        BodyClient (+ optional documents/revisions). backendKind()
                        and makeBackend()/makeBodyClient() are the seam every
                        entrypoint calls through. initBackend() bootstraps pg
                        schemas async, before serving.
    server.ts          createServer(client, {documents?, revisions?}) ->
                        McpServer. Registers read_body/write_body/
                        append_section/edit_section always; write_document/
                        read_documents iff documents given; file_revisions/
                        revision_deltas iff revisions given.
    tools.ts           Pure handler functions (readBody/writeBody/
                        appendSection/editSection) — the thing server.ts wraps
                        and __tests__/mcp-tools.test.ts drives directly against
                        FixtureBodyClient.
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
    migrate.ts          C2 tool: chaos hasPart-carrying subjects -> calliope-db,
                        preserving section ids/text/order_key. Modes: default
                        (migrate+parity+export), --probe (drift count only),
                        --retract (post-cutover Chaos cleanup; refuses without
                        a prior export file).
    migrate-documents.ts    C3 tool: phdb history.documents -> calliope
                        documents. PHDB_DATABASE_URL (source) + DATABASE_URL
                        (dest). --probe for counts/parity only.
    migrate-revisions.ts    C4 tool: phdb file_revisions +
                        revision_triple_deltas -> calliope revisions. Denormalizes
                        (subject,predicate,object) dictionary pks to labels.
    migrate-dissolution-archive.ts   C5 tool: copies dissolutions /
                        file_revision_dissolutions / materialization_events into
                        archive_*-prefixed tables. Row-count parity is the gate.
docs/body-facet.md    C2 ownership/definition record — read this before
                       touching anything about what a "body" is or who owns it.
specs/                 spec-kit feature specs, one dir per cut:
  001-muse-sheds-ui/            the editor-UI split (mirrors aglaia's 001-the-split)
  002-facet-carve-sovereign-store/   the pg carve (C2)
  003-prose-strangle-move/      the document strangle (C3)
  004-notes-and-revision/       the revision re-home (C4)
  005-dissolution-residuals.md  the dissolution-bridge archive (C5, spec-lite)
rules/sast/dataflow.yml   opengrep vendored taint ruleset — the CI SAST gate
__tests__/              vitest, one spec file per src module (14 total):
                        backend, document-store, edit-section, fixture-client,
                        hades-capture, live-capture, mcp-documents, mcp-http,
                        mcp-tools, migrate, order-key, pg-client,
                        revision-store, urania-client.
compose.yaml           nas01 deploy: calliope-mcp + calliope-db (pgvector/pg17)
Dockerfile             multi-stage bun build; bun bundles http.ts --target=bun,
                       no node_modules shipped; apt upgrade for base-CVE fixes;
                       HEALTHCHECK via bun fetch against /mcp (expects 405)
.forgejo/workflows/deploy.yml   push-to-main gate + build + Trivy + publish +
                       deploy (nas01 runner) + cosign sign/attest
```

## Entry points

- **`calliope-mcp`** bin -> `src/mcp/main.ts` -> stdio MCP server. Run
  locally: `bun run start` (equivalently `bun run src/mcp/main.ts`).
- **`calliope-mcp-http`** bin -> `src/mcp/http.ts` -> streamable-HTTP MCP
  server on `POST /mcp`, port `8204` default. Run locally: `bun run
  start:http`. This is what the deployed container runs (`Dockerfile` CMD).
- **Library** — `src/index.ts`, consumed as `@forge/calliope` (a source
  import via `file:../calliope`, no build step). Exports the `Section` /
  `BodyClient` contract, both service backends, `order-key` helpers, and the
  C3/C4 store classes.
- **Migration CLIs** — the four `src/mcp/migrate*.ts` scripts, each a
  standalone `bun run src/mcp/migrate*.ts [--probe|--retract]` invocation
  meant to run inside the deployed container (needs both `DATABASE_URL` and,
  for C3/C4/C5, `PHDB_DATABASE_URL`).

## Build / Test / Run

All commands from `package.json` scripts — bun runs TypeScript directly, no
build step, no `dist/`:

```sh
bun install                # deps (packageManager: bun@1.3.14, engines.node >=22.13)
bun run lint                # eslint . (typescript-eslint strictTypeChecked + stylisticTypeChecked)
bun run typecheck           # tsc --noEmit
bun run test                # vitest run
bun run test:watch          # vitest
bun run format              # prettier --write "**/*.{ts,tsx,md,json,css}"
bun run format:check
bun run start                # calliope-mcp (stdio)
bun run start:http           # calliope-mcp-http (:8204)
```

Local dev backend defaults to `urania`/`chaos` reads unless you set
`CALLIOPE_MCP_BACKEND=fixture` (safe, in-memory) or `DATABASE_URL` (real
`pg` backend, needs a reachable `calliope-db`). Tests drive
`FixtureBodyClient`/`FixtureDocumentStore`/`FixtureRevisionStore` — no live
network or DB needed to run `bun run test`.

CI (`.forgejo/workflows/deploy.yml`, on push to `main`, non-docs paths):
format:check → lint → typecheck → test → `bun audit --audit-level=high` →
opengrep SAST (`rules/sast/`, blocking) → `docker compose build --no-cache` →
Trivy image scan (blocking on fixable HIGH/CRITICAL) → registry publish →
`docker compose up -d` on the `nas01` runner → cosign sign + SBOM attest →
Dependency-Track upload (non-fatal).

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
- **`editSection` is optional on `BodyClient`** for backward compatibility,
  but both shipped clients (`FixtureBodyClient`, `UraniaBodyClient`,
  `PgBodyClient`) implement it. `editSection`/`edit_section` REJECTS loudly
  if a configured backend lacks it — no silent fallback to a coarse rewrite.
- **`CALLIOPE_URANIA_WIRED` gates the live substrate transport** inside
  `UraniaBodyClient`; `backend.ts` sets it on for both live substrate
  backends (`urania`, `hades`) — if you construct a `UraniaBodyClient`
  directly outside that factory, you must set the flag yourself or writes
  silently no-op.
- **`CHAOS_URL` is legacy-`URANIA_URL`-compatible** — both env vars are
  honored for the same setting throughout (`live-capture.ts`, `compose.yaml`
  comments). Post-C2, this path is migration/retraction reads ONLY; the
  serving path is `pg`.
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
- **`compose.yaml` interpolates `${CALLIOPE_DB_PASSWORD}` at deploy time** —
  an unset var ships the literal string as the real credential. The deploy
  workflow explicitly guards this (`test -n "$CALLIOPE_DB_PASSWORD"` before
  `docker compose up`); preserve that guard in any workflow edit.
- **`eslint.config.mjs` ignores `**/*.config.*`** including itself and
  `vitest.config.ts` — don't expect lint to catch issues in those files.
- No `AGENTS.md`/`CLAUDE.md` exists in this repo as of this writing — fleet
  governance that normally layers on top isn't present in this worktree.

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
  the only home for bodies; post-C2, migration-read-only for Calliope.
- **`athena`** — the planning-graph facet; a consumer of Calliope's body
  verbs (`revise_section_node`), and the owner of the unrelated `hasBody`
  literal (see gotchas).
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
