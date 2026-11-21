import { blake2b } from "@noble/hashes/blake2.js";
import {
  createKafkaTransport,
  produce,
  record,
  tombstone,
  TOPIC_CONSCIOUSNESS,
  wireKey as contractWireKey,
  type ConsciousnessEvent,
  type Transport,
} from "@forge/stellar-core-ts/kafkatopics";

export const CONSCIOUSNESS_TOPIC = TOPIC_CONSCIOUSNESS;
export const SOURCE_STAR = "calliope";
/** eros's slice for note rows — the table `from_calliope_note` wrote. */
export const NOTES_SOURCE_TABLE = "calliope_notes";
export const SCHEMA_TYPE = "Note";
export const SCHEMA_VERSION = "1.0.0";

/** The metadata keys this producer emits — the de facto vocabulary. */
export const METADATA_KEYS = [
  "title",
  "date_sent",
  "source_path",
  "tags",
  "container",
  "revision",
  "author_kind",
  "created_at",
  "updated_at",
  "lifecycle",
  "schema_type",
] as const;

export type AuthorKind = "human" | "star" | "session";
export type Lifecycle = "active" | "archived";

/** What the producer needs to know about one note — assembled by
 *  `note-projection.ts` from the container and the graph, never stored. */
export interface NoteProjection {
  node: string;
  body: string;
  title?: string;
  sourcePath?: string;
  tags?: readonly string[];
  revision?: number;
  authorKind?: AuthorKind;
  createdAt?: string;
  updatedAt?: string;
  lifecycle?: Lifecycle;
  schemaType?: string;
}

/** What the server hangs off its write verbs. `retract` is the other half:
 *  a suppressed or purged note leaves the index by a TOMBSTONE on its row's
 *  compaction key, which eros's consumer reaps (`TombstoneIdentity`), and a
 *  restore brings it back by an ordinary `publish`. Without it the index kept
 *  serving every note `delete_note` hid. */
export interface NotePublisher {
  publish(projection: NoteProjection): Promise<boolean>;
  retract(node: string): Promise<boolean>;
}

const HEX64 = /^[0-9a-f]{64}$/;
const MASK63 = (1n << 63n) - 1n;

/** `styx://<64-hex>` — the constellation address eros keys the row on. */
export function styxRef(node: string): string {
  const token = node.trim().toLowerCase();
  if (!HEX64.test(token)) {
    throw new Error(`not a chaos token: ${node}`);
  }
  return `styx://${token}`;
}

/** eros `keys.record_source_id`: blake2b-8 of the ref, masked to 63 bits. */
export function recordSourceId(ref: string): bigint {
  const digest = blake2b(new TextEncoder().encode(ref), { dkLen: 8 });
  let value = 0n;
  for (const byte of digest) value = (value << 8n) | BigInt(byte);
  return value & MASK63;
}

/** Build the event for one note. Keys the note has nothing for are ABSENT.
 *  Field order matches the contract's `ConsciousnessEvent` producer shape;
 *  kept identical to the pre-kafkatopics literal so the wire bytes this
 *  producer emits are unchanged (see the module doc). */
export function noteEvent(p: NoteProjection, now: Date): ConsciousnessEvent {
  const ref = styxRef(p.node);
  const metadata: Record<string, unknown> = {};
  if (p.title !== undefined && p.title !== "") metadata.title = p.title;
  metadata.date_sent = p.updatedAt ?? now.toISOString();
  if (p.sourcePath !== undefined && p.sourcePath !== "") {
    metadata.source_path = p.sourcePath;
  }
  if (p.tags !== undefined && p.tags.length > 0) {
    metadata.tags = [...new Set(p.tags)].sort();
  }
  metadata.container = ref.slice("styx://".length);
  if (p.revision !== undefined) metadata.revision = p.revision;
  if (p.authorKind !== undefined) metadata.author_kind = p.authorKind;
  if (p.createdAt !== undefined) metadata.created_at = p.createdAt;
  if (p.updatedAt !== undefined) metadata.updated_at = p.updatedAt;
  if (p.lifecycle !== undefined) metadata.lifecycle = p.lifecycle;
  if (p.schemaType !== undefined && p.schemaType !== "") {
    metadata.schema_type = p.schemaType;
  }
  return {
    schema_version: SCHEMA_VERSION,
    source_star: SOURCE_STAR,
    source_table: NOTES_SOURCE_TABLE,
    source_id: recordSourceId(ref),
    content: p.body,
    schema_type: SCHEMA_TYPE,
    metadata,
    source_ref: ref,
  };
}

/**
 * The compaction key — `source_table:source_id`, the contract's own
 * `consciousness` key rule (topics.ts). Thin wrapper so callers in this
 * file (and its tests) keep the pre-kafkatopics one-argument shape.
 */
export function wireKey(event: ConsciousnessEvent): string | null {
  return contractWireKey(CONSCIOUSNESS_TOPIC, event);
}

/** The compaction key of *node*'s row — `calliope_notes:<source_id>`, the
 *  same key {@link wireKey} answers for any event about that note, so a
 *  tombstone on it forgets exactly the row a publish wrote. */
export function noteKey(node: string): string {
  return `${NOTES_SOURCE_TABLE}:${String(recordSourceId(styxRef(node)))}`;
}

/** The JSON value `produce`/`record` would put on the wire for `event` —
 *  schema defaults filled, validated, `source_id` as a raw integer literal.
 *  Exposed for tests that want the bytes without a transport. `null` only
 *  for a tombstone (`Record_`'s shared shape with `tombstoneRecord`); this
 *  function only ever calls `record`, which never builds one. */
export function wireValue(event: ConsciousnessEvent): string | null {
  return record(CONSCIOUSNESS_TOPIC, event).value;
}

let published = 0;
let retracted = 0;
let failed = 0;
let wired = 0;

/** The heartbeat metrics: always present, so absence of a writer is a value. */
export function consciousnessMetrics(): Record<string, number> {
  return {
    calliope_consciousness_published_total: published,
    calliope_consciousness_retracted_total: retracted,
    calliope_consciousness_publish_failed_total: failed,
    calliope_consciousness_publisher_wired: wired,
  };
}

/** Zero the counters (tests). */
export function resetConsciousnessMetrics(): void {
  published = 0;
  retracted = 0;
  failed = 0;
  wired = 0;
}

/** The 1-2-5 series: 1, 2, 5, 10, 20, 50, … — the failures worth a WARNING.
 *  No separate `total < 1` guard: `unit` only ever grows past 1 when
 *  `total >= 10`, so for any `total < 1` the comparison below already falls
 *  through to `false` on its own — a guard here would be dead weight, not a
 *  behaviour. */
export function escalates(total: number): boolean {
  let unit = 1;
  while (unit * 10 <= total) unit *= 10;
  return total === unit || total === 2 * unit || total === 5 * unit;
}

export class ConsciousnessPublisher implements NotePublisher {
  readonly #transport: Transport;
  readonly #now: () => Date;

  constructor(transport: Transport, opts: { now?: () => Date } = {}) {
    this.#transport = transport;
    this.#now = opts.now ?? ((): Date => new Date());
    wired = 1;
  }

  /** Publish one note; never throws. Returns whether the broker took it.
   *  `produce` fills the contract's schema defaults, validates, and encodes
   *  before handing the transport a byte — a refusal there (a value this
   *  producer built breaking its own schema) is handled exactly like a
   *  broker fault: counted, logged, never crashing the star. */
  async publish(projection: NoteProjection): Promise<boolean> {
    let event: ConsciousnessEvent;
    try {
      event = noteEvent(projection, this.#now());
    } catch (err) {
      this.#fail(projection.node, err);
      return false;
    }
    try {
      await produce(this.#transport, CONSCIOUSNESS_TOPIC, event);
    } catch (err) {
      this.#fail(projection.node, err);
      return false;
    }
    published += 1;
    return true;
  }

  /** Tombstone one note's row; never throws. Returns whether the broker
   *  took it. A tombstone for a row eros never held reaps nothing, so this
   *  is safe to repeat (an `already_suppressed` note is retracted again,
   *  which heals a row a pre-tombstone suppress left behind). */
  async retract(node: string): Promise<boolean> {
    try {
      await tombstone(this.#transport, CONSCIOUSNESS_TOPIC, noteKey(node));
    } catch (err) {
      this.#fail(node, err);
      return false;
    }
    retracted += 1;
    return true;
  }

  #fail(node: string, err: unknown): void {
    failed += 1;
    if (!escalates(failed)) return;
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `calliope-consciousness: note ${node.slice(0, 16)} did NOT reach the` +
        ` index — ${reason} (${String(failed)} failed publish(es) since` +
        ` start; the index is behind)\n`,
    );
  }
}

/** The trimmed `KAFKA_BOOTSTRAP`, or `undefined` when publishing should be
 *  off — an explicit `CALLIOPE_CONSCIOUSNESS_EMIT=0`, or nothing (or only
 *  blank) in `KAFKA_BOOTSTRAP`. The one place either fact is decided:
 *  {@link consciousnessEmitEnabled} and {@link makeConsciousnessPublisher}
 *  both resolve through this rather than each trimming their own copy —
 *  the second copy an env var that is merely unset (never `""` past the
 *  trim) could ever disagree with. */
function resolvedBootstrap(env: NodeJS.ProcessEnv): string | undefined {
  if (env.CALLIOPE_CONSCIOUSNESS_EMIT === "0") return undefined;
  const trimmed = (env.KAFKA_BOOTSTRAP ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Publishing is ON whenever the fleet hands this process a broker, and only
 *  an explicit `CALLIOPE_CONSCIOUSNESS_EMIT=0` turns it off. The retired emit
 *  was an opt-in nobody opted into; a default-on with a loud off is the
 *  opposite posture on purpose. */
export function consciousnessEmitEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolvedBootstrap(env) !== undefined;
}

/** The client id this producer's transport connects under — its own named
 *  constant (not an inline literal in {@link makeConsciousnessTransport})
 *  so its value is directly testable without reaching into the client's
 *  internals. */
export const CONSCIOUSNESS_CLIENT_ID = "calliope-consciousness";

/** Build the kafkatopics transport. Topic creation belongs to the
 *  telemetry bus's provisioning, never a producer side effect — a compacted
 *  topic auto-created with the broker's defaults would not compact. */
export function makeConsciousnessTransport(bootstrap: string): Transport {
  return createKafkaTransport(bootstrap, CONSCIOUSNESS_CLIENT_ID);
}

/** The boot-time factory: a publisher when enabled, else `undefined` — and a
 *  stderr line either way, so the absence of a writer is never quiet. */
export function makeConsciousnessPublisher(
  env: NodeJS.ProcessEnv = process.env,
): ConsciousnessPublisher | undefined {
  const bootstrap = resolvedBootstrap(env);
  if (bootstrap === undefined) {
    process.stderr.write(
      "calliope-consciousness: NOT publishing note events — " +
        (env.CALLIOPE_CONSCIOUSNESS_EMIT === "0"
          ? "CALLIOPE_CONSCIOUSNESS_EMIT=0"
          : "KAFKA_BOOTSTRAP is unset") +
        "; notes written by this process will not reach the index\n",
    );
    return undefined;
  }
  process.stderr.write(
    `calliope-consciousness: publishing note events to ${CONSCIOUSNESS_TOPIC} (bootstrap=${bootstrap})\n`,
  );
  return new ConsciousnessPublisher(makeConsciousnessTransport(bootstrap));
}
