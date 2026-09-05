/**
 * The note projection — what one note looks like to the index, assembled at
 * publish from the container and the graph, persisted nowhere (pass 4, F1).
 *
 * The container holds the prose (its blocks, in position order); the note's
 * graph node holds everything a searcher would filter by — `hasTag` edges,
 * the provenance attributes the dissolve sink reconciles (`title`,
 * `source_path`, `mtime`, `ctime`, `schema_type`), and the archive marker.
 * The tree's history gives the revision ordinal and, when the note carries no
 * local timestamps, the first and last transaction times.
 *
 * Absent stays absent: a note with no tags yields no `tags`, a note never
 * dissolved from a file yields no `source_path`. The producer turns each
 * absence into a missing key, never an empty one.
 */

import type { ContainerFacet } from "../container-write.js";
import { containerHistory, readContainer } from "../container-read.js";
import type { AuthorKind, NoteProjection } from "./consciousness-emit.js";

/** Provenance attributes the dissolve sink writes as literal edges. */
const ATTRIBUTES = [
  "title",
  "source_path",
  "mtime",
  "ctime",
  "schema_type",
  "isArchived",
] as const;

type Attribute = (typeof ATTRIBUTES)[number];

function isAttribute(predicate: string): predicate is Attribute {
  return (ATTRIBUTES as readonly string[]).includes(predicate);
}

/**
 * Assemble the projection for *node*, or `undefined` when the container
 * holds no prose (nothing to index — eros would skip it anyway).
 */
export async function projectNote(
  facet: ContainerFacet,
  node: string,
  extras: { authorKind?: AuthorKind } = {},
): Promise<NoteProjection | undefined> {
  const read = await readContainer(facet, node);
  const texts = read.blocks
    .filter((b) => !b.dangling && b.text !== null)
    .map((b) => b.text ?? "");
  const body = texts.join("\n\n");
  if (body.trim() === "") return undefined;

  const edges = await facet.dial.edges(node);
  const attrs: Partial<Record<Attribute, string>> = {};
  const tags = new Set<string>();
  for (const edge of edges) {
    if (edge.isNode) continue;
    if (edge.predicate === "hasTag") {
      tags.add(edge.value);
    } else if (isAttribute(edge.predicate)) {
      attrs[edge.predicate] = edge.value;
    }
  }

  const history = await containerHistory(facet, node);
  const first = history.at(0)?.at ?? undefined;
  const last = history.at(-1)?.at ?? undefined;

  const projection: NoteProjection = {
    node,
    body,
    lifecycle: attrs.isArchived === "true" ? "archived" : "active",
  };
  if (attrs.title !== undefined) projection.title = attrs.title;
  if (attrs.source_path !== undefined) {
    projection.sourcePath = attrs.source_path;
  }
  if (attrs.schema_type !== undefined) {
    projection.schemaType = attrs.schema_type;
  }
  if (tags.size > 0) projection.tags = [...tags].sort();
  if (history.length > 0) projection.revision = history.length;
  const createdAt = attrs.ctime ?? first;
  if (createdAt !== undefined) projection.createdAt = createdAt;
  const updatedAt = attrs.mtime ?? last;
  if (updatedAt !== undefined) projection.updatedAt = updatedAt;
  if (extras.authorKind !== undefined) {
    projection.authorKind = extras.authorKind;
  }
  return projection;
}
