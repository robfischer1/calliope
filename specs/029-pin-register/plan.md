---
title: "The Pin Store (calliope half)"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: draft
---

# The Pin Store (calliope half) — Design Plan

> **Binding contract.** Every item is `decided` or `[OPEN]`. (Constitution I/II)

## Summary

The 028 register grows the second grain: a pin list (append on `pointer-pin`,
dedupe by pinId, remove by unpin, arrival-ordered). `handleTelemetryMessage`
folds the new event type through the same guard. `look` returns `pins` beside
`focus`, each pin drift-checked exactly as the live focus is (one shared
verdict helper). A new `unpin` verb removes one pin. Fences grow `unpin`.

## Contracts & Seams

### Exposes
| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `look` (widened) | `{ focus: …, pins: [{ pin_id, pointer, received_at, drift, current_text? }] }` — arrival order | decided |
| `mcp_tool:calliope:unpin` | `unpin(pin_id: string) -> { removed: true, pin_id }` · miss → `{ error: "unknown_pin", detail }` | decided |
| `FocusRegister.pin/unpin/pins` | `pin(pinId, pointer, receivedAt)` (dedupe) · `unpin(pinId): boolean` · `pins()` (never mutates) | decided |
| consumer fold | `{type:"pointer-pin", pinId, pointer}` — guard-checked like selection | decided |

### Consumes / Requires
| Dependency | Contract | Pin |
| :--- | :--- | :--- |
| theia 060's event | `PointerPinEvent {pinId, pointer}` on the telemetry topic | theia@main (landing in lockstep) |
| 028's register + look + drift helper | this feature widens them | calliope@main |

### Resource-Reach — verified
| RR pointer | Access | Role |
| :--- | :--- | :--- |
| `file:apps/calliope/src/focus-register.ts` | write | pin store + fold |
| `file:apps/calliope/src/mcp/tools.ts` | write | look widening + unpin |
| `file:apps/calliope/src/mcp/server.ts` | write | unpin registration |
| `file:apps/calliope/__tests__/focus-register.test.ts` + `mcp-http.test.ts` | write | conformance + fences |

## Decision Log
| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Unpin surface | an MCP verb (session-side) | "clear pin 2" is conversational; the editor only pins (060) | Default (binding) | editor unpin events (needs list UI first) |
| Dedupe | by pinId | the wire is at-least-once (events.ts Base contract) | Claude (vocabulary) | none (duplicate pins) |
| Order | arrival | "compare these three" reads in pin order | Default (binding) | ts order (same in practice) |
| Pin persistence | process memory | same durability class as live focus; a DB store is a surfaced open | Default (binding; surfaced) | persisting now (unlicensed scope) |
| unpin annotations | `[false, true, true]` | removes state (destructive of the pin), idempotent-from-caller | Default (binding) | — |

## Open & risk
- Pin persistence across restarts; a pin-list UI; multi-pin comparison semantics — surfaced, master-plan carried.
- A pin anchored to a block a merge delete-and-recreates is orphaned (B2 supersessions hazard) — drift answers `gone`, which is the honest signal today.

---
Definition of Ready: all checked.
