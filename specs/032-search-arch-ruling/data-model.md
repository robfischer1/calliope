# Data Model: Rule the desktop search architecture

Reconciled verbatim from the planning context's Shared-data-model slice: **"the hit
shape — snippet, score, provenance of which arm ranked it."** F1 defines the shape;
F2 implements it. No storage lands in this feature.

## The hit

The unit every search arm produces and RRF fuses. One interface, both backends.

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `id` | string | the addressable thing the hit resolves to (note/block/document identity as the owning backend addresses it) |
| `snippet` | string | the matched excerpt, ready for highlight rendering |
| `score` | number | the fused RRF score (post-fusion, not an arm-internal score) |
| `arms` | string[] | provenance — every arm that ranked this hit (`fts` \| `semantic` \| `eros`) |

## The search response envelope

Carries the degradation contract (the ruling's Scope acceptance: "RRF fuses what is
available and the UI names what is not").

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `hits` | Hit[] | ranked, fused results |
| `armsQueried` | string[] | arms that answered this query |
| `armsDark` | string[] | arms that exist in the architecture but did not answer (with N=0 both lists empty ⇒ "no arms available", distinguishable from `hits: []` with arms queried) |

## State transitions

An arm's availability is evaluated **per-query** (research.md): dark → available
requires no restart or re-registration; the next query simply includes it.
