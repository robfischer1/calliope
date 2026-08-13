# Tasks: The Live-Clear Fold

### T001 — clearFocus + fold + tests  ·  S
- **Acceptance:** clearFocus empties `current()` only (pins survive); the
  fold handles the event tolerantly; idempotent on empty; suite green under
  `bun run gate`.
- **Touches:** write `file:apps/calliope/src/focus-register.ts`, `file:apps/calliope/__tests__/focus-register.test.ts`.

---
Done-when: gate green.
