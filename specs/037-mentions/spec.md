# Feature Specification: Mentions over the index

**Status**: Draft | **Input**: Findability master-plan F11 — "Backlinks and
unlinked mentions over the index" (the index half; the panel halves land in
theia chrome + grace).

## Requirement

- **FR-001**: The local index extracts wikilinks at index grain (alias,
  heading-ref, and path forms normalized to the note name) into a links
  table maintained transactionally with the blocks.
- **FR-002**: A `mentions(id)` ferry verb answers TRUE linked mentions —
  corpus-wide, never extent-bounded (what ships today answers a narrower
  question) — plus unlinked candidates: FTS hits for the note's title
  excluding existing linkers and self. The candidate false-positive rate is
  the recorded trade (term-AND matching, bounded depth).
- **FR-003**: No index wired = the honest empty answer, mirroring search.

## Success Criteria

- **SC-001**: Tests: link-form normalization; corpus-wide linked mentions;
  candidate exclusion of linkers + self; re-index moving a link; the ferry
  verb (200 + refusal).

## Notes

The verb is ferry-only this feature (the panel is the consumer); an MCP
registration for agents is a recorded follow-up (it would extend the F3
fence deliberately, as search and has_body did).
