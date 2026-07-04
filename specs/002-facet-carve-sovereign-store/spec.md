# Feature Specification: Cut 1 — the Prose-Body Facet Carve (Sovereign Store)

**Status**: Draft | **Input**: Master-plan C2 head + Rob's build-gate decisions (2026-07-04): **sovereign store NOW** (bodies migrate out of Chaos, the Muse pattern — Clio/Terpsichore precedent) and **Calliope owns ALL bodies** (work-node plan prose included; Athena is a consumer of the verbs).

> The "L, tricky" heart of the Wave-2 dissolution slice. The two decisions the plan surfaced for Rob are decided; this spec binds them.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Every body consumer keeps working, now against Calliope's own store (Priority: P1)

The board's plan prose, the projection bodies, and every future prose body are served by the same five verbs on `calliope-mcp` — but the bytes live in a Calliope-sovereign database, not as substrate triples in Chaos. Consumers observe identical behavior before and after the cutover.

**Independent Test**: per-node parity — for every body-carrying node, the section list read from Chaos (pre-cutover) and from the sovereign store (post-cutover) hash identically (ordered `(text, order_key)` content hash).

**Acceptance Scenarios**:

1. **Given** the migration ran, **When** every body node is compared old-read vs new-read, **Then** 100% content-hash parity, and any mismatch blocks the cutover.
2. **Given** the cutover, **When** a client writes/edits/reads through the verbs, **Then** behavior (shapes, ordering, copy-on-write) is unchanged and the write lands only in the sovereign store.

### User Story 2 - Sovereignty means one writer, by construction (Priority: P1)

After the carve, no service can write a body except through Calliope: the store is Calliope's own database, reachable only on Calliope's private network. Chaos retains the pure facts/cognition graph; the body triples are retracted from it once parity holds.

**Acceptance Scenarios**:

1. **Given** the retraction, **When** the Chaos `moirae` graph is scanned for `hasPart` body edges, **Then** none remain, and a drift probe (repo script) proves it repeatably.
2. **Given** the end state, **When** any non-Calliope service attempts a body write, **Then** there is no path — the store is not on a shared network and Chaos no longer carries the facet.

### User Story 3 - Provenance survives the move (Priority: P2)

`authored_by` ("human" via the gateway path, "calliope" otherwise) is carried into the sovereign store per section version, preserving the identity-is-provenance invariant.

### Edge Cases

- A body written mid-migration: the migration runs against a quiesced write window (bounded — minutes) OR re-runs idempotently until a clean pass; the parity gate is the arbiter.
- Section ids: existing ids are preserved by the migration verbatim; new ids keep the 64-hex shape so consumers see no format change.
- Athena's `revise_section_node` writes `hasBody` **literals** on section-nodes — that is a graph-facet scalar (planning tenant's), NOT a body in Calliope's facet. The facet definition names this boundary; no Athena change in C2.

## Requirements _(mandatory)_

- **FR-001**: A Calliope-sovereign PostgreSQL (pgvector image — C4 will want embeddings) MUST hold all section bodies with lineage: id, node_id, text, order_key, authored_by, active flag, supersedes pointer, timestamps.
- **FR-002**: A store-backed BodyClient MUST implement readBody/saveBody/editSection with semantics identical to the substrate client (ordering COLLATE "C", copy-on-write on edit, fresh order keys on coarse save).
- **FR-003**: The service MUST default to the sovereign store when configured (DATABASE_URL) and retain the chaos backend only for migration reads.
- **FR-004**: A migration tool MUST enumerate every body-carrying node in the Chaos `moirae` graph, copy all bodies preserving section ids/order/text/provenance where recorded, and emit a per-node parity artifact (content-hash old vs new); parity failures block cutover.
- **FR-005**: After verified cutover, the body triples (`hasPart` edges + section-node text/order_key/type facts) MUST be retracted from Chaos, and a drift probe MUST verify zero remaining (and be re-runnable to detect regressions).
- **FR-006**: The facet definition (what is a body, who owns it, what stayed in Chaos, the Athena `hasBody`-literal boundary) MUST be written down in the repo (`docs/body-facet.md`).
- **FR-007**: The five verbs' wire shapes MUST be byte-identical through the carve.

## Success Criteria _(mandatory)_

- **SC-001**: 100% parity artifact across all migrated nodes (count reported; zero mismatches).
- **SC-002**: post-cutover live round-trip via Hades (write/append/edit/read on a scratch node) — green, and the rows appear in the sovereign store with correct provenance.
- **SC-003**: drift probe reports zero body triples in Chaos post-retraction.
- **SC-004**: full repo gate green; deploy green; container healthy.
- **SC-005**: the board renders its plan prose unchanged (spot-check via read_body on known projection nodes).

## Assumptions

- The store rides in calliope's own compose stack (`calliope-db`, private `calliope-net`), password bws-held (`CALLIOPE_DB_PASSWORD`, pantheon convention) and injected at deploy via a repo Actions secret — the repo-CI deploy lane, matching how this star already ships.
- The migration runs on nas01 (east-west with chaos + calliope-db), as a one-shot command in the built image — not from a workstation.
- Retraction is the LAST step, run only after parity + live verification, in the same feature (bounded, not deferred).
