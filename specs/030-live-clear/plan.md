---
title: "The Live-Clear Fold (calliope half)"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: draft
---

# The Live-Clear Fold — Design Plan

> **Binding contract.** (Constitution I/II)

## Summary
Two touches: `FocusRegister.clearFocus()` (ambient slot only; pins untouched)
and a `pointer-live-clear` case in `handleTelemetryMessage`. No verb changes,
no fence changes.

## Contracts & Seams
| Surface | Shape | State |
| :--- | :--- | :--- |
| `FocusRegister.clearFocus()` | `(): void` — `current()` answers null after | decided |
| fold | `{type: "pointer-live-clear"}` → clearFocus | decided |

Consumes: theia 061's event (landing in lockstep). RR: `focus-register.ts` +
its test file — write.

## Decision Log
| Decision | Resolution | Rationale | Provenance |
| :--- | :--- | :--- | :--- |
| Clear scope | ambient slot ONLY | pins are deliberate intent; the opt-out is about ambient data | Claude (master-plan F7) |
| No verb | the pipe carries the signal | same no-new-pipe rule as everything else | Claude (master-plan) |

---
Definition of Ready: all checked.
