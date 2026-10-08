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
import blob_census from "./output-schema/calliope_blob_census.schema.json" with { type: "json" };
import container_history from "./output-schema/calliope_container_history.schema.json" with { type: "json" };
import copy_reference from "./output-schema/calliope_copy_reference.schema.json" with { type: "json" };
import create_note from "./output-schema/calliope_create_note.schema.json" with { type: "json" };
import delete_note from "./output-schema/calliope_delete_note.schema.json" with { type: "json" };
import dissolve_note from "./output-schema/calliope_dissolve_note.schema.json" with { type: "json" };
import export_note from "./output-schema/calliope_export_note.schema.json" with { type: "json" };
import file_revisions from "./output-schema/calliope_file_revisions.schema.json" with { type: "json" };
import list_by_tag from "./output-schema/calliope_list_by_tag.schema.json" with { type: "json" };
import list_tags from "./output-schema/calliope_list_tags.schema.json" with { type: "json" };
import look from "./output-schema/calliope_look.schema.json" with { type: "json" };
import materialize_note from "./output-schema/calliope_materialize_note.schema.json" with { type: "json" };
import read_container from "./output-schema/calliope_read_container.schema.json" with { type: "json" };
import restore_note from "./output-schema/calliope_restore_note.schema.json" with { type: "json" };
import revision_deltas from "./output-schema/calliope_revision_deltas.schema.json" with { type: "json" };
import search from "./output-schema/calliope_search.schema.json" with { type: "json" };
import set_properties from "./output-schema/calliope_set_properties.schema.json" with { type: "json" };
import unpin from "./output-schema/calliope_unpin.schema.json" with { type: "json" };
import write_container from "./output-schema/calliope_write_container.schema.json" with { type: "json" };

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
  read_container,
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

/** The zod form of a verb's output schema, compiled once. */
export function outputSchemaOf(verb: SchemaVerb): z.ZodType {
  let schema = compiled.get(verb);
  if (schema === undefined) {
    schema = z.fromJSONSchema(DOCUMENTS[verb] as z.core.JSONSchema.JSONSchema);
    compiled.set(verb, schema);
  }
  return schema;
}
