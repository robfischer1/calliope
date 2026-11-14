/**
 * aglaia's verbs (Charon parity rows 19 and 20), registered beside the note
 * verbs: `tag_seed_read` always, `writing_deltas_ingest` when the server
 * carries a telemetry producer. The behaviour and the refusal split live in
 * `../aglaia-ingest.ts`; this file only puts them on the wire.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MAX_BATCH,
  TELEMETRY_TOPIC,
  ingestBatch,
  isAglaiaRefusal,
  readTagSeed,
} from "../aglaia-ingest.js";
import type { TelemetryProducerLike } from "../aglaia-ingest.js";
import { refusalResult } from "../refusal.js";
import { outputSchemaOf } from "./output-schemas.js";

/** A JSON value of any kind: an event's fields are the contract's to judge,
 *  so the door only holds the batch to a list of objects. */
const JSON_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
];

const event = z
  .record(
    z.string(),
    // One meta call: a later .describe() would register a fresh copy and
    // drop the advertised type.
    z.unknown().meta({
      type: JSON_TYPES,
      description: "One field of the event, as theia minted it.",
    }),
  )
  .describe(
    "One writing-delta event (eventId, nodeId, ts, type, v required by the topic's contract).",
  );

/** Register aglaia's verbs on `server`. */
export function registerAglaiaVerbs(
  server: McpServer,
  telemetry: TelemetryProducerLike | undefined,
): void {
  server.registerTool(
    "tag_seed_read",
    {
      outputSchema: outputSchemaOf("tag_seed_read"),
      annotations: { readOnlyHint: true, idempotentHint: true },
      title: "aglaia's tag-style seed",
      description:
        "The tag_styles list (tag=hue:icon) a browser merges under the " +
        "user's own setting, read per call from AGLAIA_TAG_SEED. No seed " +
        "configured refuses not_found: render tags uncoloured.",
      inputSchema: z.strictObject({}),
    },
    () => {
      const seed = readTagSeed();
      if (isAglaiaRefusal(seed)) return refusalResult(seed);
      return {
        content: [{ type: "text", text: seed.tag_styles }],
        structuredContent: { ...seed },
      };
    },
  );

  if (telemetry === undefined) return;
  server.registerTool(
    "writing_deltas_ingest",
    {
      outputSchema: outputSchemaOf("writing_deltas_ingest"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      title: "Ingest a batch of writing-delta events",
      description:
        `Produces each event onto ${TELEMETRY_TOPIC}, all or nothing, in ` +
        "one broker call. bad_args (malformed, or an event breaks the " +
        "topic's contract): DROP the batch, it will never be accepted. " +
        "backend_unavailable (the broker did not take it): KEEP the batch " +
        "and replay it.",
      inputSchema: z.strictObject({
        events: z
          .array(event)
          .min(1)
          .max(MAX_BATCH)
          .describe(`The batch, 1 to ${String(MAX_BATCH)} events.`),
      }),
    },
    async ({ events }) => {
      const answer = await ingestBatch(telemetry, events);
      if (isAglaiaRefusal(answer)) return refusalResult(answer);
      return {
        content: [
          {
            type: "text",
            text: `accepted ${String(answer.accepted)} onto ${answer.topic}`,
          },
        ],
        structuredContent: { ...answer },
      };
    },
  );
}
