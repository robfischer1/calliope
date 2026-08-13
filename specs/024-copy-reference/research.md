# Research — Compound Copy-Reference (024)

Phase 0. The planning context (master-plan F1 tail) decided the compound form and
backend symmetry; two surfaced gaps were decided here as binding defaults
(Constitution II — deferral terminates in the plan). No unknowns remain.

## Decision: full id, not short-hash

- **Decision**: the id half of the compound is the backend's full address
  (64-hex node token / relative path).
- **Rationale**: verified against the repo — `read_body`, `create_note`'s parent
  arg, the notes-ferry `HEX64` filter, and hades' calliope verbs all take the
  full token; nothing resolves a prefix. A short-hash requires a prefix index +
  resolve verb no other feature needs. Display shortening can layer later
  without changing the contract (the compound stays parseable: the id is the
  parenthesized tail token).
- **Alternatives considered**: short-hash (master-plan's `019f8186cb`
  illustration) — rejected: unresolvable today; would force new machinery into
  F1 and couple it to an index.

## Decision: palette command, theia-side local format

- **Decision**: the affordance is a `copy-reference` surface command registered
  in write-app's existing H6 `ctx.commands` block + declared in `plugin.tsx`;
  it formats from view state and writes the clipboard.
- **Rationale**: verified against the repo — write-app registers 15+ surface
  commands this way; no per-note context-menu substrate exists. Calling the
  calliope verb through the ferry would require adding the verb to charon's
  `BODY_VERBS` allowlist (verified: `apps/server/src/lib/verbs.ts`), and the
  master-plan places no diff in charon.
- **Alternatives considered**: ferry call through charon (+1 repo, rejected by
  placement); context menu (no substrate).

## Constitution check

- **I Spec-Is-Law**: every plan item is decided or surfaced; the two master-plan
  gaps are decided as binding defaults, logged with provenance. ✓
- **II Deferral-Terminates**: no discretion passed to the executor; the Decision
  Log carries eight bindings. ✓
- **III Contracts-Named**: exposes and consumes are shaped (signatures, wire
  forms, pins), not pointed at. ✓
- **IV Conformance-Checkable**: each acceptance scenario maps to a runnable
  test (tools unit tests, sidecar dispatch test, theia command test). ✓
- **V Verify-Before-Done**: quickstart.md carries the validation script;
  implement ends with `bun run gate` (calliope) + theia's pnpm gate. ✓

## Post-design re-check

Phase 1 artifacts (data model inline in plan.md; contracts in plan.md's
Exposes; quickstart.md) reconcile the tail verbatim — the Shared-data-model
slice ("the address form") is the plan's Data model section; the seams table
carries the tail's gates (F9, F11) as this feature's outbound edges. No
divergence beyond the RR delta surfaced in plan.md.
