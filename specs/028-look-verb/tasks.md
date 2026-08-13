# Tasks: The calliope_look Pointer Verb

**Input:** plan.md · spec.md. Binding per Constitution I/II.

## Parallelization
- **Critical path:** T001 → T002 → T003 → T004 → T005. Single lane (shared files with each other and with the fences).

## Work-chunks

### T001 — types.ts: the BodyPointer mirror  ·  S
- **Acceptance:** `BodyPointer`/`FocusPointer`/`isBodyPointer` byte-compatible
  with theia 058 (same fields, same tolerant-guard semantics); guard matrix test
  mirrors theia's pins.
- **Touches:** write `file:apps/calliope/src/types.ts`.

### T002 — focus-register.ts: register + pure fold + consumer  ·  M
- **Acceptance:** `FocusRegister` is LWW and read-stable;
  `handleTelemetryMessage(register, rawValue)` folds only `selection-change`
  events whose `pointer` passes the guard (malformed JSON / other events /
  guard-failing pointers are ignored, never throw); `startFocusConsumer`
  subscribes `aglaia.writing.deltas.v1` from LATEST, group
  `calliope-focus-register`, degrades heartbeat-style (broker down → stderr
  log, serving unaffected), `stop()` disconnects.
- **Touches:** write `file:apps/calliope/src/focus-register.ts` (new).

### T003 — tools.ts `look` + server.ts registration  ·  M
- **Acceptance:** `look(client, register)` → `{focus:null}` when empty; else
  pointer + received_at + drift: `none` (excerpt matches `current.slice(offsetFrom,
  offsetTo)`), `drifted` (block resolves, mismatch — `current_text` included),
  `gone` (readBlock miss). Registered as `look` (read-only, idempotent
  annotations) when `options.focus` present; absent otherwise.
- **Touches:** write `file:apps/calliope/src/mcp/tools.ts`, `file:apps/calliope/src/mcp/server.ts`.

### T004 — http.ts boot wiring  ·  S
- **Acceptance:** boot builds the register, starts the consumer, passes
  `focus` to `createServer`; shutdown stops the consumer; a broker fault at
  boot does not prevent serving.
- **Touches:** write `file:apps/calliope/src/mcp/http.ts`.

### T005 — fences + full gate  ·  S
- **Acceptance:** tools/list pin + annotations map grow `look`; `bun run gate` green.
- **Touches:** write `file:apps/calliope/__tests__/mcp-http.test.ts`, new `file:apps/calliope/__tests__/focus-register.test.ts` (+ look cases in a suitable suite).

---
Done-when: gate green; the verb serves from a fixture-fed register in tests.
