/**
 * The output schemas of calliope's fleet verbs (stellar-core F17).
 *
 * foundry-dies/schema/tool-output/calliope_<verb>.schema.json is the authority;
 * the files beside this module are its byte-identical copies, digest-gated by
 * the tool_output_calliope_* contracts. A schema describes the SUCCESSFUL
 * answer only: a refusal is an isError result, which the SDK never validates.
 *
 * The MCP SDK registers a zod schema, so each document is compiled once with
 * z.fromJSONSchema and the server advertises what the SDK renders from it.
 */
import { z } from "zod";
import blob_census from "./output-schema/blob_census.schema.json" with { type: "json" };
import container_history from "./output-schema/container_history.schema.json" with { type: "json" };
import copy_reference from "./output-schema/copy_reference.schema.json" with { type: "json" };
import create_note from "./output-schema/create_note.schema.json" with { type: "json" };
import delete_note from "./output-schema/delete_note.schema.json" with { type: "json" };
import dissolve_note from "./output-schema/dissolve_note.schema.json" with { type: "json" };
import export_note from "./output-schema/export_note.schema.json" with { type: "json" };
import file_revisions from "./output-schema/file_revisions.schema.json" with { type: "json" };
import list_by_tag from "./output-schema/list_by_tag.schema.json" with { type: "json" };
import list_tags from "./output-schema/list_tags.schema.json" with { type: "json" };
import look from "./output-schema/look.schema.json" with { type: "json" };
import materialize_note from "./output-schema/materialize_note.schema.json" with { type: "json" };
import move_blocks from "./output-schema/move_blocks.schema.json" with { type: "json" };
import read_container from "./output-schema/read_container.schema.json" with { type: "json" };
import read_containers from "./output-schema/read_containers.schema.json" with { type: "json" };
import restore_note from "./output-schema/restore_note.schema.json" with { type: "json" };
import revision_deltas from "./output-schema/revision_deltas.schema.json" with { type: "json" };
import search from "./output-schema/search.schema.json" with { type: "json" };
import set_properties from "./output-schema/set_properties.schema.json" with { type: "json" };
import unpin from "./output-schema/unpin.schema.json" with { type: "json" };
import write_container from "./output-schema/write_container.schema.json" with { type: "json" };

const DOCUMENTS = {
  blob_census,
  container_history,
  copy_reference,
  create_note,
  delete_note,
  dissolve_note,
  export_note,
  file_revisions,
  list_by_tag,
  list_tags,
  look,
  materialize_note,
  move_blocks,
  read_container,
  read_containers,
  restore_note,
  revision_deltas,
  search,
  set_properties,
  unpin,
  write_container,
} as const;

/** A verb with a published output schema, by the name calliope registers it under. */
export type SchemaVerb = keyof typeof DOCUMENTS;

const compiled = new Map<SchemaVerb, z.ZodType>();

/**
 * `format: "date-time"` is an annotation the CLIENT enforces (Ajv with
 * ajv-formats: an RFC 3339 instant with any `Z` or `±HH:MM` offset). zod's
 * converter reads it as `z.iso.datetime()`, which accepts only `Z`, and
 * renders a Z-only `pattern` into the advertised schema, so a New York stamp
 * (`-04:00`) would fail on the server and be refused by every client. The
 * walk below lifts the two date-time shapes out of the document before zod
 * sees them and puts them back, verbatim, as annotations on the compiled
 * node: zod then accepts the string and advertises exactly what the authority
 * says.
 *
 *   {"format": "date-time"}                                  (beside its type)
 *   "anyOf": [{"format": "date-time"}, {"maxLength": 0}]     (an instant, or "")
 */
const KEEP = "x-advertised";
const INSTANT_OR_EMPTY = JSON.stringify([
  { format: "date-time" },
  { maxLength: 0 },
]);

function liftDateTime(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(liftDateTime);
  if (node === null || typeof node !== "object") return node;
  const src = node as Record<string, unknown>;
  const instantOrEmpty = JSON.stringify(src.anyOf) === INSTANT_OR_EMPTY;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (instantOrEmpty && key === "anyOf") continue;
    // A literal is data, not a schema: never walk into one.
    out[key] =
      key === "enum" || key === "const" || key === "default"
        ? value
        : liftDateTime(value);
  }
  if (instantOrEmpty) {
    out[KEEP] = { anyOf: src.anyOf };
  } else if (out.format === "date-time") {
    delete out.format;
    out[KEEP] = { format: "date-time" };
  }
  return out;
}

/** The registry zod writes a node's annotations to: the kept keys go back under their own names. */
const registry = {
  add(schema: z.core.$ZodType, meta: Record<string, unknown>) {
    const { [KEEP]: kept, ...rest } = meta;
    z.globalRegistry.add(schema, {
      ...rest,
      ...(kept as Record<string, unknown> | undefined),
    });
    return this;
  },
} as unknown as typeof z.globalRegistry;

/** The zod form of one output-schema document. */
export function compileOutputSchema(document: unknown): z.ZodType {
  return z.fromJSONSchema(
    liftDateTime(document) as z.core.JSONSchema.JSONSchema,
    { registry },
  );
}

/** The zod form of a verb's output schema, compiled once. */
export function outputSchemaOf(verb: SchemaVerb): z.ZodType {
  let schema = compiled.get(verb);
  if (schema === undefined) {
    schema = compileOutputSchema(DOCUMENTS[verb]);
    compiled.set(verb, schema);
  }
  return schema;
}
