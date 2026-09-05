---
title: "The container does not care who is writing"
spec: "./spec.md"
status: draft
---
# Design Plan
Verification only. One test (`__tests__/writer-agnostic-container.test.ts`) over the fixture rig: `create_note` by title → `write_container` add → `read_container` / `materialize_note` byte-equal, no tags, no provenance; idempotent title; in-place update keeps the slot. Zero production lines. Contract stated in `docs/consciousness-producer.md`'s neighbour: containers are prose + identity; the notes path's machinery is optional.
## Exposes
| Surface | State |
| :--- | :--- |
| the writer-agnostic container contract | confirmed, not built |
