---
title: "Compound Copy-Reference"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: draft
---

# Compound Copy-Reference — Design Plan

> **Binding contract.** Every item is `decided` (executor MUST follow — no discretion)
> or `[OPEN]` (spec is silent and it matters — executor SURFACES it back, never invents).
> No advisory tier, no "use judgment." Open is the only license for discretion. (Constitution I/II)

## Summary

One addressing primitive, three landings: (1) a `copy_reference` verb on the
calliope MCP server — given a node id, return the compound reference
`[[<title>]] (<id>)` with the title resolved from the notes graph; (2) the same
verb on the fs sidecar dispatch, where the id IS the relative path and the title
is the basename — `BodyClient` symmetry applied to addressing; (3) a
`copy-reference` palette command in theia's write surface that formats the same
compound from view state and writes it to the clipboard. The format is pinned by
tests at every site. This is master-plan F1 of "Look At This — The Attention
Pointer"; it gates F9 (folders→lenses) and F11.

## Architecture

- `apps/calliope/src/mcp/tools.ts` — `formatCompoundReference(title, id)` (the
  pure formatter, one source of the format in this repo) + `copyReference(dial,
  nodeId)` (graph-backend title resolve + format).
- `apps/calliope/src/mcp/server.ts` — register `copy_reference` inside the
  existing `options.chaos !== undefined` block (title lives on the notes graph;
  same gating as `create_note`).
- `apps/calliope/src/mcp/sidecar.ts` — `copy_reference` case in the fs dispatch:
  path form, title = basename sans `.md`/`.markdown`.
- `repo:theia apps/aglaia/src/view/write-app.tsx` — `copy-reference` command via
  the existing H6 `ctx.commands` registration block; formats from view state
  (open note's id + resolved title) and writes `navigator.clipboard`.
- `repo:theia apps/aglaia/src/plugin.tsx` — declare the command in the
  `commands: [...]` manifest (the established surface-command pattern).

## Contracts & Seams

### Exposes — the interface this provides
| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `mcp_tool:calliope:copy_reference` | `copy_reference(node_id: string) -> { compound: string, wikilink: string, id: string, title: string, address_form: "node" }` · miss → `{ error: "unknown_node", detail }` | decided |
| `sidecar_verb:copy_reference` | `{verb: "copy_reference", args: {node_id: path}} -> { compound, wikilink, id: path, title, address_form: "path" }` | decided |
| `ui_command:copy-reference` | palette command on the open note → clipboard carries `compound` | decided |
| the compound form | `[[<title>]] (<id>)` — wikilink half is the real title, id half is the backend's address | decided |

### Consumes / Requires — the seams (what this CALLS)
| Dependency | Contract relied on (signature consumed) | Pin |
| :--- | :--- | :--- |
| `chaos dial` | `dial.resolveNodes(ids: string[]) -> Record<hex64, name>` | `chaos-client.ts` (same dial `create_note` uses) |
| `fs node identity` | node id IS the served-root-relative path (`fs-client.ts` `#resolve`) | calliope@main |
| `theia host commands` | `ctx.commands.register(name, fn)` + `plugin.tsx` `commands` manifest | theia@main (H6) |
| `theia resolved names` | write-app holds the open note's id + resolved title (notes-ferry `resolveNodes`) | theia@main |
| resolution of the id half | existing read surface: `calliope_read_body(node_id)` (hades) — no new resolve verb | calliope@main |

### Resource-Reach — touched, field-level (VERIFIED against the real repo)
| RR pointer | Access | Role | Used by |
| :--- | :--- | :--- | :--- |
| `file:apps/calliope/src/mcp/tools.ts` | write | formatter + copyReference | verb |
| `file:apps/calliope/src/mcp/server.ts` | write | registerTool (chaos block) | verb |
| `file:apps/calliope/src/mcp/sidecar.ts` | write | fs dispatch case | path form |
| `file:repo:theia apps/aglaia/src/view/write-app.tsx` | write | palette command + clipboard | affordance |
| `file:repo:theia apps/aglaia/src/plugin.tsx` | write | command manifest entry | affordance |

**RR delta vs master-plan:** master-plan Touches named `server.ts` + `theia view/`
only. `tools.ts` (where every verb's logic lives), `sidecar.ts` (the fs backend's
actual dispatch — required by the Scope's fs acceptance), and `plugin.tsx` (the
command manifest — required by the H6 pattern) are reconcile-time discoveries,
same-seam, surfaced here.

## Data model

The Shared-data-model slice — **the address form** (the contract every other
pointer feature reads):

- **Compound reference** = `wikilink ⧺ " " ⧺ "(" ⧺ id ⧺ ")"` where
  `wikilink = "[[" + title + "]]"`.
- `title` — the note's real title (graph `hasName` on calliope; basename sans
  extension on fs). Never a storage path on the graph backend.
- `id` — the mounted backend's address: 64-hex node token (calliope) · served-root-relative
  path (fs). **The id half is the address of record**; the wikilink half is
  display-only and honestly stale after a rename.
- `address_form` — `"node" | "path"` — carried in the verb result so callers
  know what they hold. (This is the F3 discriminant lesson applied at the
  address grain.)

## Decision Log
| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Compound form | `[[title]] (id)` | master-plan TURN 109 | Claude (master-plan) | URL scheme (rejected by Rob) |
| Backend determines the address | node hex on calliope, path on fs | BodyClient symmetry | Claude (master-plan) | — |
| Id half: full or short-hash | **full id** | every existing verb resolves it today; a prefix index is new machinery nothing needs yet; a display-shortening can layer later without breaking the contract | Default (binding) | short-hash + prefix-resolve verb |
| Affordance placement | **command palette** (`copy-reference` via H6 `ctx.commands`) | the established surface-command pattern; no per-note context-menu machinery exists in the view code | Default (binding) | context menu (no substrate); both |
| Theia formats locally, no ferry call | UI composes `[[title]] (id)` from view state | charon `/body` is verb-allowlisted and the master-plan places NO diff in charon ("diffs land in calliope, theia, grace"); theia web is always node-id-backed so its form is static; format pinned by tests both sides | Default (binding) | add `calliope_copy_reference` to charon BODY_VERBS + ferry call (rejected: expands placement) |
| Verb gating | `copy_reference` registers only with the chaos facet | the title lives on the notes graph; same gate as `create_note` | Default (binding) | registering always + erroring at call time |
| Title sanitization | strip `\n`/`\r` from the wikilink half, emit verbatim otherwise | the id half carries resolution; mangling titles breaks recognition | Default (binding) | escaping `]]`/`|` (mangles) |
| Grace UI affordance | **not in this feature** | F1 proves the fs form at the verb/dispatch seam; no grace UI feature exists in this plan | Default (binding) | building a grace gesture (scope creep) |

## Dependencies

- Sidecar dispatch case depends on the tools.ts formatter.
- server.ts registration depends on the tools.ts `copyReference`.
- Theia command depends on nothing in calliope (formats locally) — the two
  landings are independently mergeable; the calliope verb is the canonical
  formatter for agents and the sidecar.

## Impact
| Slice | Impact (0–10) |
| :--- | :--- |
| calliope verb + sidecar | 3 |
| theia palette command | 2 |

## Open & risk

- **Format duplication (surfaced divergence):** the compound template exists in
  calliope (`formatCompoundReference`) and theia (the command's local format) —
  forced by the no-charon-diff placement. Both sites carry a test pinning the
  identical form; the consolidation point is adding the verb to charon's
  `BODY_VERBS` later.
- **Full 64-hex id is long** in pasted prose. Accepted; a display-shortening
  (prefix + resolve index) is a later widening, not this contract.
- A title containing `]]` or `|` produces a wikilink Obsidian would misparse —
  the id half still resolves; noted in tests as the honest behavior.
- Sequencing (binding, from spec): this lands **before or with** F9.

---
Definition of Ready (the gate — must pass, not vacuously):
[x] every decision resolved + provenance-tagged (incl. defaults)
[x] Contracts & Seams complete — every exposed surface has a shape; every consumed dep pinned with its signature
[x] Resource-Reach field-level AND verified against the real repo (no invented paths)
[x] dependencies stated, no cycles
[x] constitution check is real (authored + each principle checked) — see research.md
