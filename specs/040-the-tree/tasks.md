---
description: "Forge work-chunks — binding, conflict-checked, executor-optimized"
---

# Tasks: The Tree

**Input:** plan.md · spec.md. **Binding:** Constitution I/II.

## Parallelization

- **Critical path:** T001 → T002 → T003 (single lane — T002 imports T001's
  widened dial; T003 exercises both).

## Work-chunks

### T001 — The dial speaks blobs and tenants  ·  M  ·  sequential
- **Serves:** dial-widening slice.
- **Acceptance:** Given `opAdd(from, pred, {toBlob: "17"})`, Then the op
  carries `to_blob: "17"` and neither `to_literal` nor `to_node`; Given
  `edges()` on a wire answer whose entry carries `domain: "blob"`, Then the
  NodeEdge reports `domain === "blob"` and `isNode === false`, and entries
  without the key report their domain from `is_node` (F2's only-when-blob
  wire rule); Given `tenantScope("documents")`, Then the scope resolves per
  tenant with env override, and `tenantScope("notes")` equals the value
  `notesScope()` answered (compat pinned); Given `registerGraph(name)` on the
  live dial, Then chaos's `register_graph` is called once, idempotently;
  Given a FixtureChaosDial batch [createNode(Block, "b:a0"), addEdge("b:a0",
  …)], Then the edge lands on the minted token (themis's label rule:
  non-empty, first create wins, batch-local) and blob edges round-trip with
  their domain.
- **Touches:** write `file:apps/calliope/src/chaos-client.ts` (`opAdd`/
  `opRemove` targets, `NodeEdge.domain`, `edges()` parse, `tenantScope`,
  `ChaosDial.registerGraph`, FixtureChaosDial).
- **Decisions-slice:** registerGraph on the chaos door [Claude]; fixture
  label parity [Claude].
- **Conflicts-with:** none. **Open:** —
- **Size basis:** one file, five seams, fixture parity logic → M.

### T002 — The tree module  ·  M  ·  sequential
- **Serves:** tree-vocabulary slice — the fan-out contract.
- **Acceptance:** Given `slotBirthOps(container, "b:a0", "a0", "17")`, Then
  it yields exactly [createNode(Block, "b:a0"), addEdge(container,
  tree_member, node "b:a0"), addEdge("b:a0", tree_position, literal "a0"),
  addEdge("b:a0", tree_content, blob "17")] — one batch, FR-007; Given
  `repointOps(slot, oldBlob, newBlob)` / `repositionOps(slot, old, new)` /
  `moveOps(slot, fromContainer, toContainer)` / `slotRemoveOps(slot,
  container, position, blob)`, Then each yields retract+assert pairs
  touching ONLY the named facts; Given `readTree(dial, container)`, Then it
  answers `TreeSlot[]` ordered bytewise by position with `{slot, position,
  blobId}` and reports a slot missing its content fact as dangling (never
  skipped); And the vocabulary constants are the single source (no string
  literals at call sites).
- **Touches:** create `file:apps/calliope/src/tree.ts`; call
  `module:chaos-client` (dial, op builders).
- **Decisions-slice:** slot model [Rob/MP]; fractional positions [Default];
  dangling content surfaced [MP: never fabricate].
- **Conflicts-with:** T001 (imports it). **Open:** —
- **Size basis:** vocabulary + 5 builders + ordered read assembly → M.

### T003 — The tree suite  ·  M  ·  sequential
- **Serves:** SC-001..005.
- **Acceptance:** Given the fixture dial, When the suite runs, Then: ordered
  resolution for 0/1/many members (SC-001); one blob in two containers AND
  twice in one container (SC-002); move preserves blob id, reorder mints no
  blob — asserted on the ops, not just the read (SC-003); tenant isolation —
  writes scoped to `documents` invisible via a `notes`-scoped read path
  (SC-004); slot birth is ONE admit batch and the fixture resolves its
  labels (SC-005); a slot with no content fact reads as dangling.
- **Touches:** create `file:apps/calliope/__tests__/tree.test.ts`.
- **Conflicts-with:** none. **Open:** —
- **Size basis:** ~10 tests over the fixture dial → M.

---
Done-when: tasks complete ✓ · no [P] claimed · critical path T001→T003 ·
Exposes trace to plan ✓
