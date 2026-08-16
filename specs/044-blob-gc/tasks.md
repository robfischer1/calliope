# Tasks: Blob Garbage Collection

T001 chaos held_blobs verb + conformance (landed f29dc47) →
T002 GcStore (pg marks table + fixture) →
T003 runBlobCensus (snapshot-first, roster, mark-and-sweep, dangling) →
T004 blob_census verb (execute explicit) →
T005 six-test suite (mark→sweep, grace, incomplete refusal, dangling,
empty-vs-no report, snapshot frame).
Acceptance per task = the spec's FR/SC lines, binding.
