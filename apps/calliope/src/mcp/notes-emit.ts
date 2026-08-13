/**
 * The eros emit path (Findability F8) — every note body write also emits
 * `(node_id, body_text, ts)` on the `calliope-notes` topic, the keep-fresh
 * stream eros's consumer turns into `calliope_notes` chunks. Rides the SAME
 * {@link IndexPusher} seam the urania similarity push proved: best-effort,
 * decorated around the persisting client, never failing the body write.
 *
 * The bulk seed of pre-existing notes is the eros-backfill ops job at
 * deploy time; this stream is the steady state (the CQRS half).
 */

import { Kafka, logLevel } from "kafkajs";
import type { IndexPusher } from "./index-push.js";

export const NOTES_TOPIC = "calliope-notes";

/** The wire event — eros's `from_calliope_note` contract. */
export interface NoteEmitEvent {
  node_id: string;
  body_text: string;
  ts: string;
  schema_version: 1;
}

/** The producer surface this pusher needs (kafkajs' or a test double). */
export interface NotesProducer {
  connect(): Promise<void>;
  send(record: {
    topic: string;
    messages: { key: string; value: string }[];
  }): Promise<unknown>;
}

/** Is the emit configured on? Explicit opt-in — a dev sidecar or fixture
 *  backend must never try to dial a broker. */
export function notesEmitEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.CALLIOPE_NOTES_EMIT === "1";
}

/** Build the kafkajs producer (the boot's default factory). */
export function makeNotesProducer(bootstrap: string): NotesProducer {
  const kafka = new Kafka({
    clientId: "calliope-notes-emit",
    brokers: [bootstrap],
    logLevel: logLevel.NOTHING,
  });
  return kafka.producer({ allowAutoTopicCreation: true });
}

export class ErosNotesPusher implements IndexPusher {
  #producer: NotesProducer;
  #connected: Promise<void> | null = null;

  constructor(producer: NotesProducer) {
    this.#producer = producer;
  }

  async indexDocument(node: string, body: string): Promise<void> {
    this.#connected ??= this.#producer.connect();
    await this.#connected;
    const event: NoteEmitEvent = {
      node_id: node,
      body_text: body,
      ts: new Date().toISOString(),
      schema_version: 1,
    };
    await this.#producer.send({
      topic: NOTES_TOPIC,
      messages: [{ key: node, value: JSON.stringify(event) }],
    });
  }
}

/** Fan a push out to every configured index — one failing never stops the
 *  others (each is independently best-effort; the decorator already
 *  swallows a total failure). */
export function fanOutPushers(pushers: readonly IndexPusher[]): IndexPusher {
  return {
    async indexDocument(node: string, body: string): Promise<void> {
      const results = await Promise.allSettled(
        pushers.map((p) => p.indexDocument(node, body)),
      );
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length === pushers.length && pushers.length > 0) {
        // Every projection failed — let the decorator log/swallow it.
        throw new Error("all index pushes failed");
      }
    },
  };
}
