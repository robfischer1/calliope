# The Body Facet — definition and ownership (C2, 2026-07-04)

The Wave-2 dissolution carve (`specs/002-facet-carve-sovereign-store`), binding
Rob's two build-gate decisions.

## What a body is

A node's **body** is its prose section tree: the ordered list of sections —
`(text, order_key)` pairs with copy-on-write version lineage — that the five
verbs serve (`read_body` / `write_body` / `append_section` / `edit_section`,
plus Athena's `revise_section_node` at the graph tenant's surface). Formerly
this lived as substrate triples in Chaos (`note --hasPart--> section
--text/order_key-->`, `moirae` graph); since C2 it lives in **Calliope's
sovereign store** (`calliope-db`, the `sections` table).

## Who owns it

**Calliope owns ALL bodies** — prose notes and work-node plan prose alike
[Rob, 2026-07-04]. Athena/Tantalus and every other consumer read and write
bodies only through Calliope's verbs. There is no other write path: the store
lives on `calliope-net`, reachable by nothing but `calliope-mcp` — the
enforcement is the topology, not a policy check.

## What stayed in Chaos

The pure facts/cognition graph: work-node structure (`parent`, `dependsOn`,
`status`, `hasName`, `hasType`, decision nodes, …) and every non-body fact.
Post-retraction, Chaos carries **zero** `hasPart` body edges and zero
section-typed nodes — `bun run src/mcp/migrate.ts --probe` is the repeatable
drift probe (expected: all zeros; anything else means a rogue body writer).

## The boundary hazard: Athena's `hasBody` literal

Athena's `revise_section_node` can write a **`hasBody` literal** on
section-nodes of the planning graph. That is a graph-facet **scalar** — a
node-content annotation in the planning tenant's facet — NOT a body in
Calliope's sense (different mechanism, different grain, no section tree). It
stays Athena's. The name collision is a known hazard; renaming that predicate
is Athena-lane work, out of C2's scope.

## Provenance

Each section version carries `authored_by` (`human` via the authenticated
gateway path, `calliope` for service-internal writes — including everything
migrated from Chaos, which recorded no per-section authorship on reads).

## The migration record

- Migration + parity: `bun run src/mcp/migrate.ts` (idempotent; per-node
  sha256 over the ordered `(order_key, text)` list, chaos-read vs pg-read;
  any mismatch exits nonzero).
- Export artifact: full JSON dump of every body at `EXPORT_PATH` (default
  `/tmp/calliope-migration-export.json`) — written before retraction, the
  rollback record.
- Retraction: `--retract` (refuses without the export; re-verifies parity
  first) removes `hasPart` edges + section-node `text`/`order_key`/`hasType`
  facts, current and superseded versions alike.
