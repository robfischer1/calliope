# Quickstart: validating the search verb

## Prerequisites

- bun 1.3.14; `bun install` at the workspace root.
- Offline path needs nothing else. Real-encoder path: `bun run fetch-search-assets`
  (populates `apps/calliope/models/`, ~24 MB from the pinned HF URLs).

## The offline suite (CI's path — no assets, no network)

```sh
cd apps/calliope && bun run test
# fs-search tests: chunker, store, fusion, degradation, one-forward-pass (SC-003
# via counting FakeEmbedder), watcher/coalesce, sidecar dispatch, tool registration
```

## End-to-end with the real encoder (SC-001)

```sh
bun run fetch-search-assets
mkdir -p /tmp/search-root && printf 'the heron lands at dusk\n' > /tmp/search-root/heron.md
bun run src/mcp/sidecar.ts --root /tmp/search-root --port 4877 &
sleep 2   # boot + index + background embed for one file
curl -s localhost:4877/body -X POST -d '{"verb":"search","args":{"query":"heron dusk"}}'
# expect: one hit, id "heron.md", snippet with markers, arms including "fts";
# after the embed settles, re-query → arms includes "semantic", armsDark []
```

## Degradation checks (SC-002)

```sh
# no assets provisioned (unset CALLIOPE_SEARCH_ASSETS, no models/):
curl … search … | jq '.armsDark'   # ["semantic"], hits still answer from fts
```

## One-forward-pass check (SC-003)

Asserted by `__tests__/fs-search-incremental.test.ts`: index a 3-file corpus with
the counting FakeEmbedder, touch one paragraph of one file, drain the queue —
embedder invocation count for the update == 1, other files' rows byte-identical.

## Latency sanity (SC-004 precursor; F14 owns the gate)

`__tests__` includes a non-asserting timing log over a synthetic 1k-block corpus;
the F14 fixture asserts the real budgets in CI.
