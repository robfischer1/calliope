---
title: "{Title}"
spec: "{link to spec.md}"
constitution: "{link to constitution.md}"
status: draft
---

# {Title} — Design Plan

> **Binding contract.** Every item is `decided` (executor MUST follow — no discretion)
> or `[OPEN]` (spec is silent and it matters — executor SURFACES it back, never invents).
> No advisory tier, no "use judgment." Open is the only license for discretion. (Constitution I/II)

## Summary
<!-- One paragraph for an executor-LLM: what is built + the core architectural move.
     No "why it matters" narrative — the spec carries that. -->

## Architecture
<!-- Repo layout + where new code lands, as concrete paths. Modules and responsibilities. -->

## Contracts & Seams
<!-- The full bidirectional interface surface, shapes named (not pointed-at). Constitution III. -->

### Exposes — the interface this provides
| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `mcp_tool:server:verb` | `verb(arg: T, …) -> Shape` | decided |
| `api:METHOD /path` | req `{…}` → resp `{…}` · {status} | decided |
| `port:NNNN` | {protocol · what listens} | decided |

### Consumes / Requires — the seams (what this CALLS)   <!-- stock spec-kit drops this -->
| Dependency | Contract relied on (signature consumed) | Pin |
| :--- | :--- | :--- |
| `mcp:server` | `verb(args) -> shape` | server@ver |
| `api:host METHOD /path` | req sent → resp expected | external |
| `sibling:repo-or-plan` | interface/tag consumed | repo@tag |

### Resource-Reach — touched, field-level (VERIFIED against the real repo)
<!-- Real, resolved pointers — not invented paths. Each distributes into a task's Touches. -->
| RR pointer | Access | Role | Used by |
| :--- | :--- | :--- | :--- |
| `file:src/…py` | read/write | {what} | {slice} |
| `db_field:t.col` | write | {the column} | {slice} |
| `function:path:fn` | call | {what it does} | {slice} |

## Data model
<!-- Entities/fields/relationships/state transitions, or defer to data-model.md;
     if deferred, the seam shapes above stay authoritative. -->

## Decision Log
<!-- FULL record incl. defaults. A Default picked on a deferral is BINDING here,
     not a hint the executor may re-decide. Constitution II. -->
| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| {question} | {chosen} | {why} | Rob \| Default \| Claude | {rejected} |

## Dependencies
<!-- Slice-level X depends on Y, no cycles. These + the seams ARE the edges tasks.md consumes. -->
- {Slice B} depends on {Slice A}

## Impact
| Slice | Impact (0–10) |
| :--- | :--- |
| {Slice A} | {n} |

## Open & risk
<!-- Unresolved [OPEN] gaps + what could break. Surfaced, never invented away. -->
- {open item / risk}

---
Definition of Ready (the gate — must pass, not vacuously):
[ ] every decision resolved + provenance-tagged (incl. defaults)
[ ] Contracts & Seams complete — every exposed surface has a shape; every consumed dep pinned with its signature
[ ] Resource-Reach field-level AND verified against the real repo (no invented paths)
[ ] dependencies stated, no cycles
[ ] constitution check is real (authored + each principle checked) — not passed-by-vacuity
