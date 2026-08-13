---
title: "The calliope_look Pointer Verb"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: draft
---

# The calliope_look Pointer Verb — Design Plan

> **Binding contract.** Every item is `decided` or `[OPEN]`. (Constitution I/II)

## Summary

Three pieces: (1) the F3 type mirror (`BodyPointer` + `isBodyPointer`) in
calliope's types.ts, byte-compatible with theia's, both pinned by tests;
(2) `focus-register.ts` — an in-memory LWW register + a kafkajs consumer on
the existing telemetry topic (`aglaia.writing.deltas.v1`), heartbeat-style
graceful degradation; (3) the `look` tool (served as `calliope_look` through
hades) — reads the register, verifies the excerpt against the live block via
the existing `readBlock` path, answers a tri-state drift verdict.

## Architecture

- `apps/calliope/src/types.ts` — the type mirror (F3's deferred calliope half).
- `apps/calliope/src/focus-register.ts` — NEW: `FocusRegister` (set/current),
  `handleTelemetryMessage` (pure: parse → filter → fold), `startFocusConsumer`
  (kafkajs wrapper, modeled on `mcp/heartbeat.ts`).
- `apps/calliope/src/mcp/tools.ts` — `look(client, register)` + result shapes.
- `apps/calliope/src/mcp/server.ts` — register `look` when `options.focus` present.
- `apps/calliope/src/mcp/http.ts` — boot: build the register, start the
  consumer, pass `focus` into `createServer`; stop the consumer on shutdown.

## Contracts & Seams

### Exposes
| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `mcp_tool:calliope:look` | `look() -> { focus: null }` &#124; `{ focus: { pointer: BodyPointer, received_at: string, drift: "none"&#124;"drifted"&#124;"gone", current_text?: string } }` | decided |
| `FocusRegister` | `set(pointer, receivedAt)` · `current()` (never mutates) — LWW, one slot | decided |
| the type mirror | `BodyPointer` / `isBodyPointer` — byte-compatible with theia 058 | decided |

### Consumes / Requires
| Dependency | Contract | Pin |
| :--- | :--- | :--- |
| Pontus topic | `aglaia.writing.deltas.v1` — batches of A15 events; selection events may carry `pointer` (theia 059) | charon `lib/pontus.ts` |
| kafkajs | consumer(groupId), heartbeat-style degrade | calliope@main (`^2.2.4`) |
| `readBlock` | `(client, nodeId, blockId) -> BlockResult | BlockMiss` — the drift read | tools.ts |
| the F2/F4 event shape | `{type:"selection-change", pointer?: BodyPointer}` | theia@main (landed) |

### Resource-Reach — verified
| RR pointer | Access | Role |
| :--- | :--- | :--- |
| `file:apps/calliope/src/types.ts` | write | type mirror |
| `file:apps/calliope/src/focus-register.ts` | write (new) | register + consumer |
| `file:apps/calliope/src/mcp/tools.ts` | write | the verb logic |
| `file:apps/calliope/src/mcp/server.ts` | write | registration |
| `file:apps/calliope/src/mcp/http.ts` | write | boot wiring |

**RR delta vs master-plan:** tail names server.ts + tools.ts. types.ts is F3's
deferred half (logged there); focus-register.ts and http.ts are the consumer's
home and boot — same-seam discoveries, surfaced here.

## Decision Log
| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Write path | consume the EXISTING telemetry topic | pull not push; the master-plan's Consumes table pins this transport; no new pipe | Claude (master-plan TURN 146/161) | a ferry write verb (needs charon allowlist; second pipe) |
| Register semantics | one in-memory LWW slot; reads never mutate | one Rob, one focus; N readers of one value | Claude (master-plan) | queue (rejected); persistence (nothing needs replay) |
| Consumer start offset | LATEST | a register wants now; history is noise | Default (binding) | fromBeginning (replays stale focus) |
| Drift shape | tri-state + current_text | resolves the "boolean or diff" gap minimally; caller can diff the two texts | Default (binding) | boolean (loses gone); server-side diff (invents a format) |
| Register scope | process-global | per-window vs global is a Rob-level open; LWW makes one slot coherent meanwhile | Default (binding; surfaced) | per-window keying (no window identity exists in the events) |
| Verb gating | registered when `options.focus` present; boot always wires it | F7 adds the settings gate; the verb itself is read-only | Default (binding) | chaos-gated (unrelated facet) |

## Open & risk
- **Per-window vs global** stays open at the master-plan level; the one-slot
  register is forward-compatible (a window key becomes part of a wider register).
- Consumer lag: a just-made selection may not have landed at read time — the
  verb answers the last KNOWN focus; acceptable for a human-speed loop.
- Briar4's parallel landings touch tools.ts/server.ts — branch cut ON TOP of
  their merged work; append-shaped edits.

---
Definition of Ready: all checked (decisions tagged incl. defaults · shapes named · RR verified, deltas surfaced · no cycles · constitution real).
