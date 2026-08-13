---
title: "Widen AuthoredBy to a Session Principal"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: draft
---

# Widen AuthoredBy to a Session Principal — Design Plan

> **Binding contract.** Every item is `decided` (executor MUST follow — no discretion)
> or `[OPEN]` (spec is silent and it matters — executor SURFACES it back, never invents).
> No advisory tier, no "use judgment." Open is the only license for discretion. (Constitution I/II)

## Summary

Widen the `AuthoredBy` provenance type from the two-value union `"human" | "calliope"` to also admit a **SPIFFE session principal** (`spiffe://{td}/session/{uuid}`), and thread a **per-call author** through the write path so an MCP caller can attribute a block write to a session. The storage column (`sections.authored_by`, already `text`) is untouched; reads already return the stored string verbatim. The core move: the type's home relocates to `types.ts` (the import root) with a runtime guard, `urania-client.ts` re-exports it for existing importers, and every sections-writing MCP verb gains an optional validated `authored_by` input that overrides the backend's instance default for that call only.

## Architecture

All diffs land in `apps/calliope/src/`:

| Path | Change |
| :--- | :--- |
| `types.ts` | `SessionPrincipal` + widened `AuthoredBy` + `SESSION_PRINCIPAL_RE` + `isAuthoredBy()` guard are **defined here** (types.ts imports nothing — no cycle). `BlockOp.authored_by` widens from its inline union to `AuthoredBy`. `BodyClient` write methods gain optional trailing `authoredBy?: AuthoredBy`. |
| `urania-client.ts` | Deletes its local `AuthoredBy` definition; **re-exports** the widened type from `types.js` (existing importers — `pg-client.ts`, `hades-capture.ts`, tests — keep their import paths). Per-call `authoredBy` params keep working, now wider. |
| `pg-client.ts` | Write methods (`saveBody`, `editSection`, `applySectionOps`, `splitSection`, `mergeSections`) accept optional per-call `authoredBy`, stamping `authoredBy ?? this.#authoredBy` into `sections.authored_by`. No DDL change. |
| `fixture-client.ts` | Same optional per-call param, threaded into fixture revisions (test parity). |
| `mcp/tools.ts` | Block helpers (`createBlock`, `updateBlock`, `deleteBlock`, `splitBlock`, `mergeBlock`, `coalesceBlockWrites`) accept optional `authoredBy` and pass it to the client call. |
| `mcp/server.ts` | Sections-writing verbs gain an optional `authored_by` zod input: `z.string().refine(isAuthoredBy, …)` — rejection message names the accepted forms. Threads to the tools/client layer. |

## Contracts & Seams

### Exposes — the interface this provides

| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `type:AuthoredBy` | `"human" \| "calliope" \| SessionPrincipal` where `SessionPrincipal = ` backtick-typed `spiffe://${string}/session/${string}` | decided |
| `fn:isAuthoredBy` | `(v: string) => v is AuthoredBy` — legacy literal OR `SESSION_PRINCIPAL_RE` (`^spiffe://[^/]+/session/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`) | decided |
| `mcp_tool:*_block / write_body / apply_section_ops / edit_section` (all sections-writing verbs) | existing inputs + optional `authored_by: string` (validated by `isAuthoredBy`; absent → today's default behavior) | decided |
| block write provenance | `sections.authored_by` carries the caller's principal verbatim when supplied | decided |
| `read_revisions` | unchanged shape; `authoredBy` field now may carry a principal string (field was already `string`) | decided |

### Consumes / Requires — the seams (what this CALLS)

| Dependency | Contract relied on (signature consumed) | Pin |
| :--- | :--- | :--- |
| `db:sections.authored_by` | `text NOT NULL DEFAULT 'human'` — already wide enough for a principal | live (pg-client.ts:38 DDL) |
| Kairos session SVIDs | `spiffe://{td}/session/{uuid}` is the fleet session-identity form | live (master-plan Consumes) |
| `zod` | `.refine()` boundary validation | zod@^3.25 (package.json) |

### Resource-Reach — touched, field-level (VERIFIED against the real repo)

| RR pointer | Access | Role | Used by |
| :--- | :--- | :--- | :--- |
| `file:apps/calliope/src/urania-client.ts` (Tail RR) | write | re-export seam; per-call params already exist (L81, 189, 328, 379) | type widening |
| `file:apps/calliope/src/pg-client.ts` (Tail RR) | write | per-call author override at the 7 `INSERT INTO sections` sites (L146–459) | write path |
| `file:apps/calliope/src/mcp/server.ts` (Tail RR) | write | optional `authored_by` input on sections-writing verbs | MCP boundary |
| `file:apps/calliope/src/types.ts` (adjacent — surfaced) | write | the type's new home; `BlockOp.authored_by` (L105) widens | everything |
| `file:apps/calliope/src/mcp/tools.ts` (adjacent — surfaced) | write | block-helper threading | MCP boundary |
| `file:apps/calliope/src/fixture-client.ts` (adjacent — surfaced) | write | fixture parity | tests |
| `db_field:sections.authored_by` | write (values only) | stores the principal; **no DDL change** | all |

## Data model

From the Tail's Shared-data-model slice — **block provenance** (read by F2, F4, F9 and any audit):

- **`sections.authored_by`** (`text NOT NULL DEFAULT 'human'`): now carries one of three value families — `'human'`, `'calliope'`, or a session principal `spiffe://{td}/session/{uuid}`. No migration; legacy rows are already-valid members of the widened domain.
- **`BlockOp.authored_by`** (Kafka block-op wire, `types.ts:105`): widens to the same `AuthoredBy` — the transaction log carries the principal the row carries.
- **Revision read model** (`types.ts:272 authoredBy: string`): already wide; returns the stored value verbatim (FR-004 satisfied by existing code — verified, `pg-client.ts:717`).

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Type's home | `types.ts` defines; `urania-client.ts` re-exports | `urania-client` imports `types.js` (L1–10) — defining the widened type in `types.ts` avoids an import cycle while keeping every existing import path working | Claude (Default — binding) | move all importers to `types.js` (bigger diff, no benefit) |
| Principal form | `spiffe://{td}/session/{uuid}` with UUID-shaped tail, via `SESSION_PRINCIPAL_RE` | the fleet session-identity form (master-plan Consumes: Kairos SVIDs); UUID tail is what Terpsichore resolves | Claude (Default — binding) | any-`string` tail (admits garbage the resolve rung can never answer) |
| Validation boundary | MCP input via `isAuthoredBy` zod refine; library layer trusts the type | the MCP surface is the only untyped ingress; internal callers are compile-time-checked | Claude (Default — binding) | re-validating in pg-client (redundant; the type already proves it) |
| Which verbs accept `authored_by` | every sections-writing verb (`write_body`, `edit_section`, `append_section`, `apply_section_ops`, `create_block`, `update_block`, `delete_block`, `split_block`, `merge_block`, `coalesce_block_writes`) | "a block write accepts a SPIFFE principal" (spec FR-001) — partial coverage would make attribution depend on which verb a session happened to use | Claude (Default — binding) | block verbs only (leaves section-grain writes anonymous) |
| Per-call vs per-instance author | optional per-call override; instance default (`#authoredBy`) unchanged when absent | FR-003 (absent → identical to today); a session principal varies per caller, an instance default cannot express it | Claude (Default — binding) | per-instance clients per session (a client pool keyed by principal — heavyweight) |
| `materialize()` default | unchanged (`"calliope"`) | machine-authored path; not a session write | Claude (Default — binding) | threading principal (no consumer) |
| Authenticity of the supplied principal | **NOT verified in F1** — form-only validation; the value rides the same trust as every current write (mTLS gateway path) | the master-plan surfaces Kairos-vs-gateway as a gap, not a decision; deciding it here would invent | [OPEN] — surfaced (master-plan gap) | — |
| `"calliope"` → workload SPIFFE id | untouched | master-plan gap; both legacy literals stay first-class (spec FR-002) | [OPEN] — surfaced (master-plan gap) | — |

## Dependencies

- Type widening (`types.ts` + re-export) precedes everything.
- Client threading (`pg-client`, `fixture-client`) depends on the type; tools threading depends on clients; server inputs depend on tools. No cycles.
- Inter-feature (Tail, verbatim): **gates F2 and F4** — the narrowest, highest-leverage change in the plan.

## Impact

| Slice | Impact (0–10) |
| :--- | :--- |
| Type widening + re-export | 2 |
| Client per-call threading | 4 |
| MCP boundary (zod + threading) | 5 |

## Open & risk

- **[OPEN] (master-plan gap, carried verbatim):** whether the principal is validated against Kairos (Cerberus F10-style PoP verification, as chaos/athena/urania now do) or trusted from the gateway. F1 ships form-validation only; the write's authenticity posture is unchanged from today. Surfaced for a future feature — measured: calliope has no `_meta`/Kairos handling and no stellar_core dependency today.
- **[OPEN] (master-plan gap, carried verbatim):** whether `"calliope"` becomes a SPIFFE workload id. Untouched here.
- **Divergence surfaced (RR):** the Tail's Touches lists three files; compilation and FR-001 coverage additionally require `types.ts` (the inline `BlockOp` union at L105 would reject principals), `mcp/tools.ts` (block helpers are the write path servers call), and `fixture-client.ts` (test parity). All three are within the master-plan's overall RR footprint (tools.ts appears in F4's Touches).
- **Risk:** the `hades` backend forwards `authored_by` to Charon (`CharonBodyRequest`), whose handling is outside this repo. The wire type widens; Charon's `SET ROLE human` behavior is unaffected for legacy values. A principal sent down that transport is forwarded as-is — noted, not changed here.
- **Risk:** Clover4 (sibling session) lands append-shaped edits to `mcp/server.ts`/`tools.ts` concurrently — pull merged main before landing.

---
Definition of Ready (the gate — must pass, not vacuously):
[x] every decision resolved + provenance-tagged (incl. defaults) — 6 decided + 2 [OPEN] surfaced (master-plan gaps, not plan silence)
[x] Contracts & Seams complete — every exposed surface has a shape; every consumed dep pinned with its signature
[x] Resource-Reach field-level AND verified against the real repo (line-verified 2026-08-13)
[x] dependencies stated, no cycles
[x] constitution check: I (every point decided/[OPEN]/non-goal — no judgment tier) · II (defaults written binding) · III (both seam sides shaped: exposes table + consumes table) · IV (Acceptance = spec scenarios + quickstart checks, falsifiable) · V (quickstart defines the read-back verification)
