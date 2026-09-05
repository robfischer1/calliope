# The consciousness producer — the note metadata vocabulary

Stream of Consciousness pass 4 (F1 + F2, 2026-09-05). Every note write
(`dissolve_note`, `write_container` on the `notes` tenant) publishes ONE
`ConsciousnessEvent` (thalassa `consciousness.py`) on the fleet's `consciousness`
topic. eros ingests it through `from_consciousness` — no Calliope-specific
extractor. The private `calliope-notes` stream is retired (see below).

## The event

| Field | Value |
| :--- | :--- |
| `source_star` | `calliope` |
| `source_table` | `calliope_notes` — eros's note slice, unchanged |
| `source_id` | `record_source_id(styx://<node>)` — blake2b-8 of the ref masked to 63 bits, **eros's own derivation**, so existing rows keep their identity; written as an integer literal |
| `content` | the container's blocks in position order, joined by a blank line |
| `schema_type` | `Note` |
| `source_ref` | `styx://<node>` |
| key | `calliope_notes:<source_id>` — the compaction key |

## `metadata` — the vocabulary

A key is **absent when the note has nothing for it** — never an empty string or list.

| Key | Source | Always | Notes |
| :--- | :--- | :---: | :--- |
| `container` | the note's node token | yes | same as `source_ref` minus the scheme |
| `date_sent` | `mtime` attribute, else the publish instant | yes | what eros's `since` / `until` arm reads |
| `title` | `title` attribute | | eros lifts it into the `title` column |
| `source_path` | `source_path` attribute (the dissolve identity) | | |
| `tags` | `hasTag` edges as the graph stores them (`#tag`), sorted, deduplicated | | absent when none |
| `revision` | number of tree transactions on the container | | |
| `author_kind` | `human` (a dissolve), `star`, `session` | | absent on a bare `write_container` |
| `created_at` | `ctime` attribute, else the first tree transaction | | |
| `updated_at` | `mtime` attribute, else the last tree transaction | | |
| `lifecycle` | `archived` when `isArchived=true`, else `active` | | |
| `schema_type` | `schema_type` attribute (the note_type provenance) | | |

eros filters today on `source` (the slice), `since` / `until` (`date_sent`) and
`focus_terms`; the rest ride in `metadata_json` and become filterable the day eros
reads them — which is why they are written down here rather than discovered.

## Not publishing is visible

The heartbeat carries `calliope_consciousness_published_total`,
`calliope_consciousness_publish_failed_total` and
`calliope_consciousness_publisher_wired` (1 when a producer exists). A refusal
never fails the write; it is counted and logged on the 1-2-5 series. Publishing is
ON whenever `KAFKA_BOOTSTRAP` is set; `CALLIOPE_CONSCIOUSNESS_EMIT=0` turns it off
and says so at boot.

## The fold (F2) — why one stream

Measured 2026-09-05 on the live broker: `calliope-notes` did not exist (thalassa's
`topics-apply` never declared it and auto-creation is off), no consumer group held
it, and the emit was gated behind `CALLIOPE_NOTES_EMIT=1`, which no deployment
set. Its only would-be consumer was eros. So there was nothing to drain and
nobody to break: the private contract is retired, and eros's `from_calliope_note`
and its `calliope-notes` subscription are retired in eros after this producer is
deployed.
