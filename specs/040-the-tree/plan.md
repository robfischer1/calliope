---
title: "The Tree"
spec: "./spec.md"
constitution: "(main checkout) .specify/memory/constitution.md"
status: ready
---

# The Tree — Design Plan

> **Binding contract.** decided or [OPEN]; no judgment tier. Reconciles the
> master-plan F3 planning context ([MP] = carried verbatim).

## Summary

Give the graph the container/slot/blob vocabulary and give Calliope the module
that speaks it: three predicates over a per-tenant graph, slot nodes of the
`Block` kind, blob-valued content facts (the F2 domain through the themis
`to_blob` wire), a generalized tenant scope replacing the notes-only dial
binding, and a tree read that resolves a container to ordered blocks. The
cross-star slices already landed: themis passes `to_blob` through the admit
wire (themis@5634c54, v0.20.0), chaos declares the `Block` kind
(chaos@3587fb7). This slice is calliope-only.

## Architecture

- `apps/calliope/src/tree.ts` — **new**: the vocabulary constants, tenant
  scope resolution, slot-op builders (one-transaction slot birth), and the
  tree read assembly over the dial.
- `apps/calliope/src/chaos-client.ts` — the dial widens: `opAdd`/`opRemove`
  accept a blob target (`to_blob`); `NodeEdge` carries the object domain;
  `edges()` parses the F2 `domain` wire key; the dial gains
  `registerGraph(name)` (chaos's own door serves `register_graph` — the
  identity-op precedent; "notes" itself was registered out-of-band);
  `notesScope` generalizes to `tenantScope` [MP: `notesScope` at :504
  generalizes to a tenant scope]; `FixtureChaosDial` models `to_blob`,
  `registerGraph`, and themis's batch-local label→mint resolution (without
  which a one-transaction slot birth is untestable offline).
- `apps/calliope/__tests__/tree.test.ts` — **new**: SC-001..005 over the
  fixture dial.

## Contracts & Seams

### Exposes — the tree vocabulary (the fan-out point [MP])

| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `pred:tree_member` | container-node → slot-node (Block kind) — membership | decided |
| `pred:tree_position` | slot-node → scalar order key (opaque string, bytewise order) | decided |
| `pred:tree_content` | slot-node → blob reference (F2 blob domain) | decided |
| `kind:Block` | the slot node kind (chaos@3587fb7, closed-set declared) | decided |
| `graphs:tenants` | `notes` · `documents` · `comments` · `governance`, one graph each, name-hashed scopes | decided |
| `module:tree` | `tenantScope(t)` · `slotBirthOps(container, slotLabel, position, blobId)` · `repointOps` / `repositionOps` / `slotRemoveOps` · `readTree(dial, container) -> TreeSlot[]` (ordered) | decided |
| `dial:registerGraph` | `registerGraph(name) -> void` — idempotent ensure | decided |

### Consumes / Requires

| Dependency | Contract | Pin |
| :--- | :--- | :--- |
| themis admit | `to_blob` on addEdge/removeEdge → chaos `{"$blob": id}` | themis@v0.20.0 (landed) |
| chaos facts/o-domain | blob-domain facts + `Block` kind | chaos@3587fb7 (landed) |
| chaos `register_graph` / `materialize_edges` | graph ensure · edge read with `domain` key (blob-only, F2 wire rule) | chaos door, live |
| calliope `blobs` | blob ids minted before facts [MP: blob → fact → ref] | F1 (landed d36c1af) |

### Resource-Reach — touched, field-level (VERIFIED)

| RR pointer | Access | Role | Used by |
| :--- | :--- | :--- | :--- |
| `file:apps/calliope/src/chaos-client.ts` (`notesScope` :504, `opAdd` :49, `NodeEdge` :83, `FixtureChaosDial` :511) [MP] | write | the dial widening | T001 |
| `file:apps/calliope/src/tree.ts` | create | vocabulary + builders + read | T002 |
| `file:apps/calliope/__tests__/tree.test.ts` | create | SC suite | T003 |
| `repo:themis go-court/internal/{ops,verbs}` [RR addition — SURFACED: absent from the master-plan RR] | landed separately | the admit wire could not carry a blob object | done |
| `repo:chaos bigintschema/schema.go` (node_kinds) [MP: "register predicates + shapes on repo:chaos"] | landed separately | the Block kind | done |

## Data model

Facts only — no tables. One slot is three facts in the tenant graph:

```
(container) --tree_member-->   (slot: Block node)
(slot)      --tree_position--> "a0"            (scalar, opaque, bytewise order)
(slot)      --tree_content-->  {$blob: 17}     (F2 blob domain)
```

Edit = retract/assert `tree_content` on the slot (blob repoint). Reorder =
retract/assert `tree_position`. Move between containers = retract/assert
`tree_member` (slot and blob unchanged). Remove = retract all three (the slot
node's tombstoning is the write path's F4 concern; F3 defines the facts).
Empty container = container node with zero `tree_member` facts — the node's
existence is the container's existence (FR-008).

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Identity is the tree slot | slot nodes of kind `Block` | [MP, Claude · Rob agreed] a fact triple cannot bind (member, position, content) per occurrence without an entity; the slot IS git's tree entry | **Rob** [MP] | flat facts (cannot express two slots of one blob, positions unbindable) |
| Position: fractional vs ordinal [MP gap] | **Fractional opaque string** (aglaia's `between()` mint, carried as scalar) | keeps the client's existing mint; a reorder touches one slot, not N ordinals | Default, per MP recommendation | integer ordinal (renumbers neighbors on insert) |
| Five tenants, five graphs | `notes` live; `documents`/`comments`/`governance` registered idempotently at first use; memories only if mnemosyne adopts the store | [MP: Rob] | — | one graph + tenant attribute (visibility unenforceable) |
| Graph registration path | the dial gains `registerGraph` → chaos door `register_graph` (idempotent EnsureGraph) | themis's wire has no registerGraph op; chaos serves it as an identity op (C4c-i verb list); "notes" itself predates any in-repo registration | Claude | widen themis again (a second cross-star change for a one-time ensure) |
| Slot-birth atomicity | one admit batch: createNode(Block, label) + three edges referencing the label ($mint resolution) | FR-007; themis already resolves batch-local labels; two admits = the orphan-slot gap D8 closed | Claude | two-phase mint (reopens D8) |
| Predicate classing | self-register unclassified; `tree_content` MUST stay non-entity (entity refuses blobs — F2 conformance-tested) | predicates self-register on first write; classing is a later hardening | Default | entity-class tree_member now (needs a declaration door that doesn't exist yet) |
| Fixture label resolution | FixtureChaosDial adopts themis's exact rule (non-empty label, first create wins, batch-local) | SC-005 must be testable offline; a fixture diverging from the door's rule is a false pass | Claude | live-only test (unrunnable in CI) |

## Dependencies

- T001 (dial widening) → T002 (tree module) → T003 (suite).
- Cross-star prerequisites all landed: themis v0.20.0, chaos 3587fb7, F1, F2.

## Impact

| Slice | Impact (0–10) |
| :--- | :--- |
| tree vocabulary | 9 (five consumers + one other master-plan read this contract [MP]) |
| dial widening | 7 |
| suite | 6 |

## Open & risk

- **[OPEN — carried from MP, unresolved here]** Whether Poseidon visibility
  binds per-graph. Not F3's frame; the master plan requires it checked
  **before F6 migrates**. Carried forward explicitly.
- **[SURFACED — RR addition]** The master-plan RR named no `repo:themis`
  touch, but the fleet routes every write through themis and its op dialect
  could not carry a blob object. Landed as themis#191/#192 (v0.20.0) with the
  invariant set preserved (gated writes, one tx per admit). **For Rob to
  ratify**; flagged in the run's completion report.
- **Risk:** slot labels are batch-local mint references, not durable names —
  a label collision inside one batch resolves to the first create (themis
  rule). The builders mint one slot per op-group with position-derived
  labels; F4's writer must keep labels unique per batch (its acceptance
  covers multi-slot saves).

---
Definition of Ready: every decision provenance-tagged ✓ · seams shaped both
sides ✓ · RR verified (line-cited; one surfaced addition) ✓ · deps acyclic ✓ ·
constitution: I no judgment tier; II the two MP gaps (position form, tenant
set) terminate here as binding Defaults, one MP omission surfaced not
invented-around; III both sides of every seam pinned; IV SC-001..005 are the
falsifiable targets; V the suite + full repo gate run before done
