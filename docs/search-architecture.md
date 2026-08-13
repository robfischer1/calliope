# The desktop search architecture — the ruling

**Status: binding.** Findability master-plan F1, ruled 2026-08-13. Every decision
below carries provenance; none is re-openable at implement time without a new ruling.
F2 (the `search` verb) and every later arm implement THIS page.

## The shape

**Eros is not a service Calliope calls — it is a shape Calliope implements.** One
`search(query, scope)` interface; N ranked-list producers ("arms"); reciprocal-rank
fusion over whatever subset of arms answers. The desktop decomposition:

| Arm | Engine | Runs | Provenance |
| :--- | :--- | :--- | :--- |
| `fts` | SQLite **FTS5** via `bun:sqlite`, in-process in the sidecar | always (offline included) | [Claude, verified live on bun 1.3.14] |
| `semantic` | **small int8 encoder on a wasm ONNX runtime**, embedded in the compiled sidecar | always for search; generation needs the embedding endpoint | [Claude · Rob approved; ships in v1 — Rob reversed the deferral] |
| `eros` | **`eros_search`** (bge-m3, hybrid + decay + engagement) | when the remote is reachable | [Fable recommended · Claude concurred; pg arm is Eros — Claude, measured] |

## The fusion — RRF as the degradation mechanism

[Claude] Reciprocal-rank fusion over N ranked lists. Its load-bearing property:
**RRF over one list is that list** — rank order passes through unchanged. Degraded
mode is therefore honest *by construction*: no fallback code path, no second-class
mode. A hit ranked by k arms accumulates k reciprocal-rank contributions and appears
once, carrying every ranking arm in its provenance.

The response envelope states fidelity (`contracts/search-hit.md` in spec 032, the
shape F2 implements):

- `hits: SearchHit[]` — `{ id, snippet, score, arms[] }`
- `armsQueried: SearchArm[]` — who answered
- `armsDark: SearchArm[]` — who exists but did not; **the UI names the dark arms**

Decided edge behavior [Default, plan 032]:

- **N=0** (no index yet, remote dark): `hits=[]`, `armsQueried=[]`, `armsDark`
  non-empty — distinguishable from "searched and found nothing".
- **Availability is per-query**, not per-session: an arm that comes back joins the
  next query; nothing latches dark.

## Freshness — the file watcher is the local CQRS

[Claude, TURN 220] Eros stays fresh by Kafka-CQRS; the desktop's equivalent is the
**existing fs watcher**: same role, different bus. Block grain pays the incremental
bill — one edited block moves exactly one row, so re-indexing an edit is **one
forward pass per edited block** (FTS5 row replace + one re-embed).

## The spike result — wasm survives the compile

**Verified 2026-08-13** (`apps/calliope/spikes/wasm-compile-spike/`): a `.wasm`
asset imported `with { type: "file" }` embeds under the sidecar's exact build
(`bun build --compile --target=bun-{linux,windows}-x64`, bun 1.3.14), reads back
inside the single-file binary, instantiates, and executes — linux binary run to
PASS; windows target compiled clean. **The int8 wasm-ONNX encoder stands** as the
semantic engine. Contingency (not selected, kept recorded): **static embeddings**
(model2vec/potion class, ~15–30 MB lookup tables, no inference runtime) if a real
ONNX runtime's asset shape diverges from this proof at F2 build time. Model sizes
quoted from training are **unverified** — F2 verifies against current releases
before downloading anything [Claude].

## The measurements that decided this (do not re-derive)

```
corpus:  4,524 markdown files · 28.8 MB · ~92,800 paragraph blocks (~75 tokens each)
         → 384-dim int8 ≈ 36 MB resident; brute-force cosine ≈ 36M MACs → tens of ms
bun:sqlite ships working FTS5 (verified, bun 1.3.14)
build:sidecar = bun build --compile --target=bun-{windows,linux}-x64 (verbatim)
```

## The prohibitions (inherited, immovable)

1. **No ANN index locally.** Brute-force cosine at this corpus size; HNSW is
   machinery for Eros's 1.3M chunks, not 92.8k. [Claude, measured]
2. **No second FTS against the remote store.** The pg arm IS Eros —
   `calliope_documents` is already indexed there (36,432 chunks, 100% embedded).
   A third FTS implementation is the programme's measured failure mode. [Claude,
   measured; supersedes Fable Wave 1.1]
3. **Nothing that breaks `bun build --compile`.** No Rust/tantivy in the sidecar —
   it breaks the compile target or forks the verbs into a second implementation.
   [Claude, verified]
4. **Vector spaces never cross the seam.** Local 384-dim int8 and Eros's bge-m3
   1024-dim are different spaces: the local index is never warmed from Eros; a
   dissolved note is re-embedded on the other side. Consistent with local/remote
   never syncing. [Claude]

## What consumes this

- **F2** implements the verb, both local arms, the fusion, and the envelope.
- **F3/F7** render `armsDark` — the UI *states* degraded fidelity, never hides it.
- **F4** routes the `eros` arm at `eros_search` with a source filter.
- Search is a **Calliope verb** — one interface, both backends, phone included;
  never a Grace-local index. [Fable recommended · Claude concurred]
