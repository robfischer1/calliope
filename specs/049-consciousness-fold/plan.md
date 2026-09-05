---
title: "One stream or two, decided rather than inherited"
spec: "./spec.md"
status: draft
---
# Design Plan
## Summary
`consciousness-emit.ts`: `ConsciousnessPublisher` over a kafkajs producer (`allowAutoTopicCreation: false` — thalassa owns the topic), `recordSourceId` (blake2b-8 via `@noble/hashes`, masked to 63 bits — eros `keys.record_source_id`), `wireKey`/`wireValue` (BigInt written as an integer literal), counters on the heartbeat (`startHeartbeat({ metrics })`), default-on emit with a loud off. `notes-emit.ts` and its test removed; `fanOutPushers` moves to `index-push.ts`. Wired once per process in `http.ts`/`main.ts`, threaded to every per-request server.
## Reconcile note
- Tail: "eros consumes both for one overlap window". The old topic never existed on the broker, so the overlap is vacuous; the eros extractor is retired in a follow-up PR AFTER this producer deploys (the producer-then-retire ordering, kept).
- Tail: "retire the contract not the topic" — there is no topic to age out; the contract (calliope's `NoteEmitEvent`) is what is deleted.
## Consumes
| Dependency | Contract | Pin |
| :--- | :--- | :--- |
| `topic:consciousness` | compact; created by `thalassa-register topics-apply` 2026-09-05 | thalassa 0.18.0 |
| eros `from_consciousness` | generic path: content + metadata, `title` lifted | eros deployed 2026-09-05 (digest 1a933b69…) |
| `@noble/hashes` blake2b `dkLen: 8` | parity with eros vectors (3 pinned) | 2.4.0 |
## Exposes
| Surface | State |
| :--- | :--- |
| `consciousness` publish (producer) | decided — the fold |
| `calliope_consciousness_published_total`, `_publish_failed_total`, `_publisher_wired` on the heartbeat | decided |
## Decision Log
| Decision | Resolution | Rationale |
| :--- | :--- | :--- |
| one stream or two | one — fold | no topic, no consumer, no emit ever ran |
| id derivation | eros's, in TS | compaction key == row identity |
| emit default | on when a broker is handed to the process | the retired emit was an opt-in nobody set |
