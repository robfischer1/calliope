# Contract: the hit + the degradation envelope

The seam F1 exposes and F2 consumes ("Inter-feature seams: gates F2"). Written by
shape (Constitution III). TypeScript is the sidecar's language; shapes are given in
its notation.

```ts
/** One fused search result. Produced only by fusion — arms never emit this shape
 *  outward; they emit internal ranked lists that fusion consumes. */
export interface SearchHit {
  /** Identity as the owning backend addresses it (note/block/document id). */
  id: string;
  /** Matched excerpt, highlight-ready. */
  snippet: string;
  /** Fused RRF score. Monotone in rank; not comparable across queries. */
  score: number;
  /** Provenance: every arm that ranked this hit. Non-empty. */
  arms: SearchArm[];
}

export type SearchArm = "fts" | "semantic" | "eros";

/** The degradation contract. armsDark is how the UI "states when an arm is dark". */
export interface SearchResponse {
  hits: SearchHit[];
  /** Arms that answered this query. */
  armsQueried: SearchArm[];
  /** Architectural arms that did not answer. Empty means full fidelity. */
  armsDark: SearchArm[];
}
```

## Invariants

1. `armsQueried ∪ armsDark` = the arms the ruled architecture defines for the
   queried backend; `armsQueried ∩ armsDark = ∅`.
2. N=1 honesty: with one arm available, `hits` is that arm's ranked list order —
   RRF over one list is the identity on rank.
3. N=0: `hits = []`, `armsQueried = []`, `armsDark` non-empty — distinguishable
   from "queried and found nothing".
4. A hit ranked by k arms appears once, with `arms.length = k` (RRF accumulates,
   never duplicates).
5. Availability is per-query: no state from a previous query may mark an arm dark.
