# Feature Specification: The bulk has-body verb

**Status**: Draft | **Input**: Findability master-plan F10.

## Requirement

- **FR-001**: One bounded call (`has_body`, ≤2048 ids) answers active-block
  counts for a whole extent; ids with no prose are absent from the answer.
  The Aglaia browse list badges without N per-node reads — footgun #5
  ("never scan a directory's contents to render its structure") honored by
  construction. Counts over booleans (the gap decision): same query cost,
  strictly more signal for the badge/filter.
- **FR-002**: The capability is optional on the BodyClient seam
  (store-backed clients implement it; the fs grain's directory has the
  local index); the tool refuses honestly on a backend without it; the
  index-push decorator passes it through (a read, no push).

## Success Criteria

- **SC-001**: MCP tests: counts for a mixed extent in one call, absent-id
  omission, the honest refusal. A real-postgres test proves the one-query
  SQL against the same `active` predicate readBody serves.
- **SC-002**: The F3 fence + annotations map carry the licensed row.

## Consumer

B1.2's list-density work (cross-bucket seam, recorded in the master-plan).
