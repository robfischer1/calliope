# Implementation Plan: Delete the Parallel Implementation (F14)

**Spec**: `spec.md` | **Planning context**: master-plan F14 tail (authoritative — reconciled, not regenerated)

## Decisions

- **One engine, two deployments** [Rob] — the desktop's backend IS the
  fleet's model, served locally; nothing conditionally branches on which
  backend is running.
- **The fs grain constraint retires with the fs backend** — engine slots
  are durable identity, so the desktop gains apply_section_ops instead of
  losing capability.
- **Markdown is the working tree** [Claude, F13] — completed here: writes
  PROJECT to disk (atomic temp+rename, blocks joined by the editor's
  separator); external edits INGEST lazily on read plus a debounced
  recursive watcher; boot runs a catch-up scan (first run: the tree seeds
  the store).
- **External edits land as ONE block** — the 0.14 de-inference rule
  outlives the backend it was written for: boundaries are user-stated,
  and a foreign editor states none.
- **Tags stay a computed walk of the working tree** — the desktop mints
  no hasTag facts; extraction reads file text only and derives no
  sections. The MODULE count still drops: the walk folds into the store.
- **Search: tsvector in the engine's postgres** [Rob: "Eros stays local
  via tsvector + pgvector"] — `local_search` (generated tsv + GIN) and
  `local_links` (wikilink targets, the F11 linked-mentions seam) tables,
  upserted on write/ingest. Semantic arm dark until pgvector ships in the
  payload; named dark, never thrown. The fs-search embeddings are NOT
  ported — the sqlite index dies whole (re-embedding is the pgvector
  feature's concern, not this deletion's).
- **The fixture backend survives** [plan recommendation accepted] —
  FixtureBodyClient keeps testing the tool layer; it is an in-memory
  store, not a second grain.

## Module map

| Piece | Fate |
| :--- | :--- |
| `fs-client.ts`, `fs-tags.ts`, `fs-revlog.ts`, `fs-search/` (9 files) | DELETED (+11 test suites) |
| `fs-search/eros-provider.ts` | MOVED to `src/eros-provider.ts` (fleet search routing) |
| search types | extracted to `src/search-types.ts` |
| `src/local-store.ts` | NEW — LocalEngineStore: BodyClient over the engine + projection + ingestion + tags + FTS search + mentions |
| `mcp/sidecar.ts` | REWRITTEN — engine REQUIRED (exit 1 without a payload); /body + /mcp ride the store; requests WAIT for boot (the handshake never does) |
| `types.ts` + `mcp/tools.ts` + `index-push.ts` | capability collapse: five methods lose `?`, their guards die, the decorator's passthroughs go unconditional |
| `urania-client.ts` | gains honest refusing stubs for the three reads its deferred transport never served |

## Behavioural parity notes

- revision = the transaction id (String(tx)); kind is always "save";
  authoredBy from the graph's author. The fs revlog's lazy capture
  becomes ingest-on-read — same invalidation model, real transactions.
- `/health` keeps `engine` + `engine_ports`; `backend` is now "engine".
- The boot gate holds /body + /mcp requests during engine boot instead of
  503ing — Grace needs no retry logic it doesn't have.
