# Measurement — 042 SC-004 (the two-store read's blob half)

**What:** batched `getTexts` of a representative 50-block container
(50 blobs × ~1 KB each), one `SELECT … WHERE id = ANY($1)` round trip,
against a real `postgres:17-alpine` testcontainer.

**Result (2026-08-16, WSL2 host rob02, dockerized PG, warm pool):**

    mean 1.53 ms over 5 runs (2.8, 1.3, 1.1, 1.2, 1.3)

**Reading:** the master-plan risk was "the cross-logical-DB blob fetch is
unmeasured — today's read is one indexed query; this is two." The blob half
of the second hop costs ~1.5 ms per 50-block container on modest hardware.
The graph half (current_facts resolution) is chaos-side and covered by its
own measured reads (extent at 1.27M-id scale, WL at 599k rows — the
in-repo benchmarks the store's comments cite). The emitting test lives in
`__tests__/blob-store.test.ts` ("fetches a 50-block container's prose in
one batched read") and prints the number on every real-postgres run, so
the figure re-measures itself wherever the suite runs.

**F6 gate reading:** two indexed hops at ~ms scale clears the migration's
"measure before F6 migrates 36k documents" requirement for the blob half;
the end-to-end number against live chaos is F6's pre-migration check
(surfaced in plan.md Open & risk).
