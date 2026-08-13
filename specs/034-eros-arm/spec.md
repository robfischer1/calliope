# Feature Specification: Route the pg arm through Eros

**Status**: Draft | **Input**: Findability master-plan F4 — "Route the pg arm through Eros"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Remote search answers from the index that already exists (Priority: P1)

A search against the store-backed (remote) backend answers from Eros — the
read-model where the dissolved notes are already indexed (36,432 chunks, 100%
embedded, hybrid retrieval with decay and engagement ranking, measured live).
No second full-text index is built anywhere. This is the fourth time the
programme nearly rebuilt something that exists; this feature is the routing
that prevents it.

**Independent Test**: With the remote arm configured, a query for phrases known
to live in dissolved notes returns ranked hits carrying Eros's ranking; the
codebase contains no new Postgres FTS index and no new embedding pipeline.

**Acceptance Scenarios**:

1. **Given** the pg backend with the remote arm configured, **When** searched,
   **Then** Eros answers with hybrid ranking, scoped to the dissolved-notes
   source — never the whole personal-history corpus.
2. **Given** Eros unreachable (or unconfigured), **When** searched, **Then**
   the response returns with the remote arm named dark — degraded honestly,
   exactly like the local arms degrade.
3. **Given** a hit, **Then** it carries the note's identity as Eros records it,
   its title where known, a snippet, and `eros` arm provenance.

### Edge Cases

- The scope parameter: remote hits have no subtree paths — scope narrows
  nothing remotely in this feature (recorded; the note-path scoping question
  belongs with F8's note indexing).
- Eros's date-skew default (hybrid mode suppresses pre-2018): dissolved notes
  must not be date-filtered away — the routing disables the default bound.

## Requirements *(mandatory)*

- **FR-001**: The store-backed server MUST accept a search provider that routes
  `search(query, scope, k)` at Eros's search verb with a source filter pinning
  the dissolved-notes source; the provider is configured by environment (its
  absence = the verb answers honest darkness, as F2 shipped).
- **FR-002**: Eros's search verb MUST accept a source filter (`source`) that
  scopes both retrieval arms to one source table — an addition to Eros's
  surface licensed by this feature's Brief ("with a source filter").
- **FR-003**: Hits MUST map to the ruled envelope: id = the source identity
  Eros records, snippet from Eros (title-prefixed where a title exists), score
  = Eros's fused score, arms = `["eros"]`; armsQueried/armsDark reflect the pg
  backend's single-arm architecture.
- **FR-004**: No new FTS index, no new embedding pipeline, no vector sharing
  across the seam (the 384-dim local space never touches bge-m3's 1024).

## Success Criteria *(mandatory)*

- **SC-001**: The provider's mapping is unit-tested against Eros's recorded
  response shape (fixture), including the unreachable → dark path.
- **SC-002**: Eros's source filter is tested server-side: a filtered search
  returns only the named source's chunks.
- **SC-003**: The calliope diff contains no SQL index, no tsvector, no
  embedding calls — routing only.

## Assumptions

- The hit identity is Eros's `source_id` (stringified). Whether the Connect
  window can open it directly is F5's verification; if it cannot, F5 adds the
  id→node resolution on the consumer side — this feature's contract is the
  envelope, not the opener — Default provenance.
- Configuration: `CALLIOPE_EROS_URL` names Eros's MCP endpoint; unset = arm
  absent (dark). The source filter value is `calliope_documents` — the source
  Eros reports for dissolved notes (verified live) — Default provenance.
