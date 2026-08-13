# Quickstart: validating the ruling + spike

## Prerequisites

- bun 1.3.14 (repo toolchain) — `bun --version`
- repo deps installed — `bun install` (workspace root)

## Validate the spike (SC-002 / FR-003)

```sh
cd apps/calliope/spikes/wasm-compile-spike
# compile with the sidecar's exact flag shape (linux target runs here):
bun build --compile --target=bun-linux-x64 spike.ts --outfile dist/spike
./dist/spike          # expected: prints the wasm function's computed result + PASS
# prove the windows target bundles identically (build only, cannot execute here):
bun build --compile --target=bun-windows-x64 spike.ts --outfile dist/spike.exe
```

Expected outcome: the linux binary instantiates the embedded wasm module and executes
an exported function (observed output recorded in the spike README and the ruling §
"The spike result"). A failure at either step selects the static-embeddings branch —
also a valid completion, recorded the same way.

## Validate the ruling (SC-001 / SC-003)

```sh
# every decision names engines/fusion/degradation with provenance:
grep -c "\[" docs/search-architecture.md   # provenance tags present
```

Read-back check (manual, from the ruling alone, no other document):

1. Name the local full-text engine, the local semantic engine, the fusion, the
   remote arm and its join condition. — all on the page.
2. State the behavior at N=0, N=1, all-arms, and a mid-session arm return. — all
   on the page.
3. State the three inherited prohibitions (no local ANN; no second FTS on the
   remote store; nothing that breaks the compile target). — all on the page.

## Repo checks

```sh
bun run lint && bun run typecheck && bun run test   # from apps/calliope
```
