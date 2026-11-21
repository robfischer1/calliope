import { Producer, stringSerializers } from "@platformatic/kafka";
import {
  KafkaTopicsError,
  TOPIC_AGLAIA_WRITING_DELTAS,
  decodeWritingDeltaEvent,
  record,
} from "@forge/stellar-core-ts/kafkatopics";
import { resolveBootstrap } from "./focus-register.js";

/** The env key the ExternalSecret-backed Secret is mounted under. */
export const TAG_SEED_ENV = "AGLAIA_TAG_SEED";

/** The A15 writing-telemetry topic: the contract's own constant. */
export const TELEMETRY_TOPIC = TOPIC_AGLAIA_WRITING_DELTAS;

/** Batches are bounded so a runaway client cannot wedge the star. */
export const MAX_BATCH = 500;

/** A refusal as this module builds it (refusal.ts puts it on the wire). */
export interface AglaiaRefusal {
  code: "not_found" | "bad_args" | "backend_unavailable";
  detail: string;
}

export function isAglaiaRefusal(v: unknown): v is AglaiaRefusal {
  return typeof v === "object" && v !== null && "code" in v && "detail" in v;
}

/** The seed, or `not_found` when none is configured. */
export function readTagSeed(
  env: NodeJS.ProcessEnv = process.env,
): { tag_styles: string } | AglaiaRefusal {
  const seed = env[TAG_SEED_ENV]?.trim() ?? "";
  if (seed === "") {
    return {
      code: "not_found",
      detail: `no tag seed configured (${TAG_SEED_ENV} is unset)`,
    };
  }
  return { tag_styles: seed };
}

/** One message as the producer takes it. */
export interface TelemetryMessage {
  topic: string;
  key: string | undefined;
  value: string | undefined;
}

/**
 * Build the contract's records for a batch, the pure half. Throws
 * `KafkaTopicsError` on the first event that breaks the contract, having
 * sent nothing. `type` stays an OPEN string in the decoder, so a theia
 * variant this fleet has not shipped yet relays through untouched.
 */
export function telemetryRecords(events: unknown[]): TelemetryMessage[] {
  return events.map((event) => {
    const decoded = decodeWritingDeltaEvent(event);
    const rec = record(TELEMETRY_TOPIC, decoded);
    return {
      topic: rec.topic,
      key: rec.key ?? (decoded.nodeId || decoded.eventId),
      value: rec.value ?? undefined,
    };
  });
}

/** The half of a producer this module drives (a test hands in a double). */
export interface TelemetryProducerLike {
  send(options: { messages: TelemetryMessage[] }): Promise<unknown>;
}

/** The producer options this module declares. Topic creation is
 *  thalassa's, never a producer side effect; no compression. */
export function telemetryProducerOptions(
  bootstrap: string,
): ConstructorParameters<typeof Producer<string, string, string, string>>[0] {
  return {
    clientId: "calliope-telemetry",
    bootstrapBrokers: [bootstrap],
    serializers: stringSerializers,
    autocreateTopics: false,
  };
}

/** The client-backed producer. Nothing is dialled until the first batch;
 *  a failed send rejects that call and the next one dials again. */
export function createTelemetryProducer(
  bootstrap: string = resolveBootstrap(),
): TelemetryProducerLike {
  return new Producer<string, string, string, string>(
    telemetryProducerOptions(bootstrap),
  );
}

/** What an accepted batch answers. */
export interface IngestAnswer {
  accepted: number;
  topic: string;
}

/**
 * Validate and produce one batch. The records are built BEFORE the send, so
 * a contract refusal never depends on whether the broker is reachable (the
 * same bad batch must not answer drop one day and replay the next).
 */
export async function ingestBatch(
  producer: TelemetryProducerLike,
  events: unknown,
): Promise<IngestAnswer | AglaiaRefusal> {
  if (!Array.isArray(events) || events.length === 0) {
    return { code: "bad_args", detail: "expected a non-empty events array" };
  }
  if (events.length > MAX_BATCH) {
    return {
      code: "bad_args",
      detail: `batch exceeds ${String(MAX_BATCH)} events`,
    };
  }
  let messages: TelemetryMessage[];
  try {
    messages = telemetryRecords(events);
  } catch (err) {
    if (err instanceof KafkaTopicsError) {
      return {
        code: "bad_args",
        detail: `event breaks ${TELEMETRY_TOPIC}: ${err.message}`,
      };
    }
    throw err;
  }
  try {
    await producer.send({ messages });
  } catch (err) {
    return {
      code: "backend_unavailable",
      detail: `broker unavailable, keep the batch and replay: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { accepted: messages.length, topic: TELEMETRY_TOPIC };
}
