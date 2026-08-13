# Tasks: The Pin Store (calliope half)

**Input:** plan.md · spec.md. Binding per Constitution I/II.

## Work-chunks (single lane: T001 → T002 → T003)

### T001 — focus-register.ts: the pin store + fold  ·  M
- **Acceptance:** `pin(pinId, pointer, receivedAt)` appends (dedupe by pinId,
  arrival order kept); `unpin(pinId)` removes exactly one, answers whether it
  existed; `pins()` never mutates; `handleTelemetryMessage` folds
  `pointer-pin` events (guard-checked pointer + string pinId; malformed
  ignored).

### T002 — tools.ts look widening + unpin; server.ts registration  ·  M
- **Acceptance:** `look` answers `pins` in arrival order, per-pin drift via
  the SAME verdict path as focus (one helper, not a fork); `unpin(register,
  pin_id)` → `{removed: true, pin_id}` or `{error: "unknown_pin"}`;
  registered with `[false, true, true]` annotations beside `look`.

### T003 — tests + fences + gate  ·  S
- **Acceptance:** focus-register.test.ts covers stack/dedupe/order/unpin/
  read-stability + look-with-pins drift matrix; both mcp-http fences grow
  `unpin`; `bun run gate` green.

---
Done-when: gate green.
