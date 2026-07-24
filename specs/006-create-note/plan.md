---
title: "The Note-Native Mint — create_note (C8)"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: draft
---

# C8 — Design Plan

> **Binding contract.** Reconciled against the master-plan C8 tail (authoritative) + live code/graph (2026-07-24): the repo restructured to `apps/calliope/src/` (the tail's `src/mcp/` pointers re-based); **no TS ChaosClient exists anywhere in the fleet** (grepped theia/charon/calliope) — the "import a ChaosClient" decision lands as a NEW `chaos-client.ts` module in calliope wrapping the east-west MCP wire (the LiveUraniaCapture transport pattern), not an import and not an extension of `HadesCapture`; the admit grammar is pinned from athena's `court.py` (the proven litigant); the Note shape is live (`c8a6c340…`, proposed, exactly one required predicate = `hasName`, parent-optional confirmed structurally); the idempotency gap resolves to the graph's own by-name identity (`find_by_name` is the documented F2 reuse lookup).

## Summary

Calliope grows the **graph-write muscle**: `chaos-client.ts` — a thin typed client with two dials (themis `admit` at `CALLIOPE_THEMIS_URL`, chaos `find_by_name` at `CALLIOPE_CHAOS_URL`, both single-POST `tools/call` JSON-RPC exactly like `LiveUraniaCapture`) — and one new verb, `create_note(title, parent?, tags?) -> {node_id, created}`: reuse-lookup by `(kind=Note, title)`; on miss, the **two-admit mint** (admit #1 `createNode {kind:"Note", label:title}` → token from `minted[]`; admit #2 the edge batch `hasName` / `hasType:"Note"` / `parent → to_node`) on scope `notes`; a parentless create parents to the ensured **"Notes" root** (kind `NoteRoot`, `anchorsRole → "Notes"` — the GHOST anchor predicate, urania `tier.py:60`); no section rows mint at birth (the body exists empty and is immediately readable — exactly the live interactive consumer's behavior); `tags` is accepted and forward-carried inert (C9 wires it). The Note shape canonizes via `urania_canonize_shape` (Rob-authorized in the "execute all remaining work" directive, 2026-07-24).

## Live-reality basis (verified 2026-07-24)

| Surface | Live state | Disposition |
| :--- | :--- | :--- |
| `graph:notes` | registered on the phantom-root guard (`ab5aa970…`, 07-21) | the mint scope (bare form) |
| Note shape | registered-**proposed** `c8a6c340…`; required = `hasName` only | canonize at implement; admit target |
| TS themis/chaos client | none anywhere (theia, charon, calliope grepped) | build thin `chaos-client.ts` in-repo |
| admit wire | `themis_admit(ops, scope)` → `{admitted, minted[], violations}`; ops `{op:"createNode", kind, label}` / `{op:"addEdge", from_id, predicate, to_literal|to_node}`; **no intra-batch refs** — mint-then-edge is two admits (athena `court.py`, `projection.py:328`) | followed verbatim |
| identity / reuse | `createNode` never dedups; `find_by_name(kind, label)` (sha256(kind‖0x1f‖normalized label)) is the documented reuse lookup | the idempotency key: `(Note, title)` |
| east-west addresses | themis `http://themis:8200/mcp` (athena settings) · chaos `http://chaos:8206/mcp` (thalia config) | env-configurable defaults |
| body store | sections attach on first write; `read_body` on a section-less node answers `{sections: []}` | mint writes no sections (matches the live "+ New" consumer) |

## Architecture

| Piece | Home | Responsibility |
| :--- | :--- | :--- |
| `ChaosClient` | `apps/calliope/src/chaos-client.ts` (new) | the east-west dials: `admit(ops, scope)` (themis) + `findByName(kind, label)` (chaos); op constructors `opCreate` / `opAdd` mirroring `court.py`; typed results; structured errors surface verbatim (never swallowed) |
| `create_note` handler | `apps/calliope/src/mcp/tools.ts` | `createNote(client, {title, parent?, tags?})`: find-by-name reuse → two-admit mint → parent resolve (caller's or the ensured root); pure over the injected client (the repo's fixture-testable handler pattern) |
| Notes-root ensure | `apps/calliope/src/chaos-client.ts` (`ensureNotesRoot`) | find_by_name(`NoteRoot`, "Notes") → mint on miss (`createNode` + `hasName` + `anchorsRole → "Notes"`); **singleton-safe**: re-find after mint (a mint race resolves deterministically to the lowest token; twins logged loudly) |
| verb registration | `apps/calliope/src/mcp/server.ts` | register `create_note` beside the body/document verbs; env: `CALLIOPE_THEMIS_URL`, `CALLIOPE_CHAOS_URL`, `CALLIOPE_NOTES_SCOPE` (default `notes`, bare — the chaos-guard convention) |
| shape canonize | implement-time gateway act | `urania_canonize_shape("c8a6c340…")` → verify `urania_shape_for("Note")` answers `canonical` |

## Data model (the Tail's shared-data-model slice)

- **write `graph:notes`** — the Note node (kind `Note`, label = title) + edges: `hasName → title` (literal, the shape's one requirement) · `hasType → "Note"` (literal, browsability — the extent's type facet) · `parent → <node>` (to_node: caller's parent or the Notes root). The root: kind `NoteRoot`, label "Notes", edges `hasName → "Notes"` + `anchorsRole → "Notes"`.
- **write calliope-db body** — the existing section store, untouched at mint (zero section rows; the body is the node's — empty — section set, `read_body`-able immediately; first editor/importer write attaches sections through the standing verbs).

## Contracts & Seams

### Exposes
| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `mcp_tool:calliope:create_note` | `create_note(title: string, parent?: hex, tags?: string[]) -> {node_id: hex, created: boolean}` · structured errors `bad_title` / `admit_refused (violations verbatim)` / `parent_not_found` | decided (the master-plan pin + additive `created`) |
| the "Notes" root | ensured singleton `NoteRoot`/"Notes" with `anchorsRole`; its `node_id` discoverable via `find_by_name` | decided |

### Consumes
| Dependency | Contract | State |
| :--- | :--- | :--- |
| `themis_admit` (east-west) | gated write; ops grammar above; `minted[]` returns tokens; violations refuse | decided (live) |
| `chaos find_by_name` (east-west) | reuse lookup, `(kind, label)` → hex tokens | decided (live) |
| Note shape `c8a6c340…` | canonize here; post-canonize every Note admit is gate-checked against `hasName` | decided |
| themis#65 (`location`) | NOT consumed — location forward-declared, backfilled later; nothing here reads or writes it | decided (deferred seam) |

## Decision Log

| Decision | Resolution | Rationale | Provenance |
| :--- | :--- | :--- | :--- |
| ChaosClient | new thin `chaos-client.ts` wrapping east-west themis+chaos | Rob decided "import a ChaosClient"; none exists to import — a dedicated in-repo client honors the decision's substance (dedicated graph-write muscle, not HadesCapture extension, not raw gateway calls) | Rob (2026-07-21) + Claude (reconcile) |
| Idempotency key | the graph's by-name identity: `(kind=Note, normalized title)` via `find_by_name` reuse-lookup | the documented F2 contract ("a caller wanting reuse-not-create looks the name up first"); same-title = same note is the importer's own re-run semantic. Limitation (v1, stated): two distinct notes cannot share a title | Claude (Default — tail gap resolved) |
| Root kind | `NoteRoot`, not `Note` | a user note titled "Notes" must not BE the root (by-name key collides); a distinct kind keeps the root invisible to Note-kind reads and un-gated by the Note shape | Claude (Default — tail gap resolved) |
| Root marker | `anchorsRole → "Notes"` | the GHOST anchor predicate (urania U9, `tier.py:60`) — the fleet's one anchor convention; A21's invisible-root filter keys on it | Claude (Default) |
| Body at birth | zero section rows | matches the live interactive consumer (createNode then editor-first-write); the importer writes sections itself; `read_body` serves the empty body immediately | Claude (Default) |
| tags in C8 | accepted, validated as `string[]`, otherwise inert | signature stability across C8→C9 (consumers integrate once); the tag write is C9's | decided (master-plan) |
| Canonize | executed this feature via `urania_canonize_shape` | tail: "canonize here — needs Rob"; Rob's 2026-07-24 "execute all remaining work" is the authorization; flagged in the completion report | Rob (via execute-all) |

## Open & risk

- **Attribution (Cerberus F10):** athena's admits ride session `_meta` proof-of-possession; calliope's east-west admit carries none — an unsigned write is *flagged* (or refused under the `fail` policy). Probe live FIRST (the S-probe); if themis refuses unsigned server-side admits, surface immediately — do not work around the gate. `[OPEN if refused]`
- **Network reach:** calliope-mcp must reach `themis:8200` + `chaos:8206` — verify the container's networks at deploy (the thalia T2 "running-while-unreachable" rake); `/ready` should report the new dials.
- **Concurrent root mint:** two racing first-creates can twin the root before the re-find settles; the ensure re-finds after mint and prefers the lowest token deterministically. Observed-twin cleanup is manual (logged loudly).
- **The gate's shape check on `NoteRoot`:** unshaped kinds admit unchecked today; if a future NoteRoot shape lands, the ensure must conform then.
