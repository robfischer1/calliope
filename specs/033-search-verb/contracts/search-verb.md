# Contract: the search verb

Both surfaces serve one shape (F1's contract, extended with the verb signature).

## MCP tool (`server.ts`, all backends)

```ts
// registerTool("search", ...)
inputSchema: {
  query: z.string().min(1),
  scope: z.string().optional(),   // root-relative subtree prefix; ""/absent = all
  k:     z.number().int().min(1).max(100).optional(), // default 20
}
// result content: SearchResponse (JSON)
```

## Sidecar wire (`/body` dispatch, fs backend)

```jsonc
{ "verb": "search", "args": { "query": "…", "scope": "Notes/", "k": 20 } }
// → 200 SearchResponse | 400 bad_request on empty query
```

## The response (F1 verbatim + coverage note)

```ts
type SearchArm = "fts" | "semantic" | "eros";
interface SearchHit {
  id: string;        // fs backend: root-relative path (the node identity)
  snippet: string;   // FTS: fts5 snippet() with … highlight markers
                     // semantic-only: block head (~200 chars), unmarked
  score: number;     // fused RRF score
  arms: SearchArm[]; // non-empty provenance
}
interface SearchResponse {
  hits: SearchHit[];
  armsQueried: SearchArm[];
  armsDark: SearchArm[];
}
```

Invariants 1–5 from F1's `contracts/search-hit.md` bind unchanged (N=1 identity,
N=0 distinguishable, per-query availability, single-appearance multi-arm hits,
queried ∩ dark = ∅).

## The provider seam (`server.ts` ⇄ backends)

```ts
/** What a backend hands the MCP server to light the verb. */
interface SearchProvider {
  search(query: string, scope?: string, k?: number): Promise<SearchResponse>;
}
// server.ts registers the tool ALWAYS; a missing provider answers
// { hits: [], armsQueried: [], armsDark: ["fts","semantic"] } — honest darkness
// until F4 routes the pg backend at Eros.
```

## `FsBodyClient` hook (index only — grain unchanged)

```ts
constructor(root: string, opts?: { onWrite?: (nodeId: string) => void })
// saveBody / editSection invoke onWrite AFTER the atomic write lands.
```

## Encoder assets (resolution order)

`CALLIOPE_SEARCH_ASSETS` env dir > `<binary dir>/search-assets/` >
`apps/calliope/models/` (dev). Contents: `ort-wasm-simd-threaded.mjs`,
`ort-wasm-simd-threaded.wasm`, `model_quantized.onnx`, `tokenizer.json` —
populated by `bun run fetch-search-assets`. Missing ⇒ semantic arm dark, named.

## Remote accelerator (optional)

`CALLIOPE_EMBED_URL` (+ `CALLIOPE_EMBED_MODEL`) — ollama `/api/embed` shape;
first response must carry 384-dim vectors or the endpoint is refused for the
process lifetime (vector-space seam). Used for bulk backfill batches only.
