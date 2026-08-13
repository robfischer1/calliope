# Feature Specification: Rule the desktop search architecture

**Status**: Draft | **Input**: Findability master-plan F1 — "Rule the desktop search architecture"

> **Gap-protocol (Constitution I).** Mark every unresolved point `[OPEN: question]` —
> never a silent guess. A reasonable default is allowed but must be logged in
> Assumptions as a Default-provenance decision, not left implicit. The WHAT lives
> here; the HOW (architecture, contracts) lives in plan.md.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The implementer opens a binding ruling before writing search code (Priority: P1)

The implementer of the search verb (F2) — and of every later search arm — opens one
written ruling and finds the whole decomposition decided: which engine ranks full-text
locally, which engine ranks semantically locally, how the ranked lists fuse into one,
how the remote arm joins when the remote embedding service is reachable, and what the
user is told when an arm is unavailable. Nothing about the decomposition is left for
implementation time.

**Why this priority**: The degradation story — search stays honest when an arm is dark —
is a design property. Bolted on later, it becomes a fallback hack; the ruling is what
designs it in.

**Independent Test**: Read the ruling with the search verb unbuilt. Every question an
implementer would ask about engines, fusion, degradation, and constraints is answered
on the page, or explicitly ruled out of scope.

**Acceptance Scenarios**:

1. **Given** the ruling, **When** the F2 implementer starts, **Then** the local
   full-text engine, the local semantic engine, the fusion mechanism, and the remote
   arm's join condition are each named with their deciding constraint.
2. **Given** N available search arms (N ≥ 1), **When** a query runs under the ruled
   architecture, **Then** fusion combines exactly the available arms and the response
   names the arms that did not answer.
3. **Given** the one unverified constraint — whether the semantic encoder's runtime
   assets survive the sidecar's compilation — **When** the ruling is published,
   **Then** that question has been answered by experiment, not assumption, and the
   ruling records the answer and the fallback chosen if the answer was no.

### Edge Cases

- Zero arms available (no index built yet, remote unreachable): the ruling must say
  what a query returns — an empty result distinguishable from "no matches".
- All arms available: fusion must not double-count a hit found by more than one arm;
  the ruling states how a multi-arm hit is ranked and attributed.
- The remote arm joining mid-session (connectivity restored): the ruling states
  whether availability is evaluated per-query or per-session.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A written ruling MUST exist, versioned with the sidecar's code, naming:
  the local full-text engine, the local semantic engine, the fusion mechanism, the
  remote arm and its join condition, and the degradation behavior for every
  availability combination.
- **FR-002**: The ruling MUST record each decision's deciding constraint and
  provenance (who decided, on what evidence) rather than bare conclusions.
- **FR-003**: The ruling MUST answer the encoder-runtime-under-compilation question
  empirically: a spike proves whether the semantic encoder's runtime assets load
  inside the compiled sidecar binary, and the ruling records the result and — if
  negative — the fallback that replaces the encoder.
- **FR-004**: The ruling MUST state the degradation contract: with any subset of arms
  available, a query returns results fused from exactly that subset, and the response
  identifies the dark arms so the UI can state them.
- **FR-005**: The ruling MUST state the constraints it inherits as already-decided
  (no re-derivation downstream): no approximate-nearest-neighbor index locally, no
  second full-text implementation against the remote store, no engine that breaks
  the sidecar's single-binary compilation.

### Key Entities

- **The ruling**: a document; names engines, fusion, degradation contract,
  constraints, provenance; consumed by F2's implementer and every later arm.
- **A search arm**: a ranked-list producer (local full-text, local semantic, remote);
  has an availability state; contributes to fusion only when available.
- **The fusion**: the mechanism combining N ranked lists into one; defined for N = 1
  such that one arm's list passes through unchanged (degradation is honest by
  construction).
- **The spike result**: the recorded empirical answer to the encoder-runtime
  question, with the fallback decision if negative.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An implementer reading only the ruling can enumerate every engine, the
  fusion mechanism, and the behavior in all availability states without consulting
  any other document.
- **SC-002**: The encoder-runtime question is closed before the search verb's first
  commit: the spike ran, its result is recorded in the ruling, and a fallback is
  named if the result was negative.
- **SC-003**: The ruling records provenance for 100% of its decisions (none appear
  as unattributed conclusions).

## Assumptions

- The ruling lives with the sidecar's code (versioned alongside what it governs), not
  in a wiki or vault — Default provenance; the master-plan's Touches names the
  sidecar's repo path for the spike and "documentation" without a home, so
  co-location with the governed code is chosen as the binding default.
- The spike need only prove the runtime question on the platform this machine can
  execute (linux-x64); the Windows compile target is asserted by the same bundling
  mechanism and inherits the result — Default provenance; cross-compiling and
  executing a Windows binary here is not possible.
