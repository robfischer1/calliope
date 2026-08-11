/**
 * The notes-backed {@link DocumentStore} (F7 — the strangler finishes).
 *
 * The `documents` table's read contract, served from the MERGED store: a
 * "document" is a note (graph identity + provenance attributes + a
 * container body), reconstructed to the `DocumentRow` wire shape on read.
 * Writes are the F6/F9 sink alone — a fresh dissolve lands note-native
 * ONLY, carries no table id (the sequence dies with the table), and its
 * durable handle is `source_path`. Migrated rows keep their old ids
 * resolvable forever through the `document_id` bridge attributes the
 * prelude wrote.
 *
 * Version semantics (the F6 model, stated once): a note's history rides
 * its container's copy-on-write revisions; `bySourcePath` serves the
 * NEWEST state as one row, not one row per version.
 */

import type { BodyClient } from "./types.js";
import type {
  DocumentRow,
  DocumentStore,
  ListDocumentsQuery,
  WriteDocumentInput,
  WriteDocumentResult,
} from "./document-store.js";
import { sha256 } from "./document-store.js";
import type { ChaosDial, NodeEdge } from "./chaos-client.js";
import type { TagStore } from "./tag-store.js";
import { sinkNoteVersion, type SinkResult } from "./notes-sink.js";

/** The write result, extended with the sink's outcome (structural superset). */
export interface NotesWriteDocumentResult extends WriteDocumentResult {
  note: SinkResult;
}

function attrsOf(edges: NodeEdge[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.isNode) continue;
    out.set(e.predicate, [...(out.get(e.predicate) ?? []), e.value]);
  }
  return out;
}

export class NotesDocumentStore implements DocumentStore {
  constructor(
    private readonly client: BodyClient,
    private readonly dial: ChaosDial,
    private readonly scope: string,
    private readonly tags?: TagStore,
  ) {}

  /** Reconstruct the wire row from a note's attributes + container body. */
  async #rowOf(nodeId: string): Promise<DocumentRow | null> {
    const edges = await this.dial.edges(nodeId);
    if (edges.length === 0) return null;
    const attrs = attrsOf(edges);
    const one = (p: string): string | null => attrs.get(p)?.at(0) ?? null;
    const sourcePath = one("source_path");
    if (sourcePath === null) return null; // not a dissolved note
    const body = (await this.client.readBody(nodeId))
      .map((s) => s.text)
      .join("\n\n");
    const ids = (attrs.get("document_id") ?? [])
      .map(Number)
      .filter((n) => Number.isFinite(n));
    return {
      id: ids.length > 0 ? Math.max(...ids) : 0,
      schema_type: one("schema_type") ?? "DigitalDocument",
      title: one("title"),
      source_path: sourcePath,
      file_path: one("file_path"),
      body_text: body,
      content_hash: sha256(body),
      raw_hash: one("raw_hash") ?? sha256(body),
      source_kind: one("source_kind") ?? "vault-note",
      mtime: one("mtime"),
      ctime: one("ctime"),
      created_at: one("dissolved_at") ?? "",
    };
  }

  async write(input: WriteDocumentInput): Promise<NotesWriteDocumentResult> {
    const note = await sinkNoteVersion(
      this.client,
      this.dial,
      this.scope,
      this.tags,
      input,
    );
    return {
      ok: true,
      table: "documents", // the wire's historical field name; consumers pass it through
      id: null,
      deduped: note.generation === "nooped",
      source_path: input.source_path,
      note,
    };
  }

  async byId(id: number): Promise<DocumentRow | null> {
    const hits = await this.dial.findByValue(
      this.scope,
      "document_id",
      String(id),
    );
    const node = hits.at(0);
    return node === undefined ? null : this.#rowOf(node);
  }

  async bySourcePath(sourcePath: string): Promise<DocumentRow[]> {
    // Vault rows: the path IS the note's name. Archive rows: the path is a
    // truthful attribute shared by many composite-named notes.
    const [named] = await this.dial.findByName("Note", sourcePath);
    const nodes =
      named !== undefined
        ? [named]
        : await this.dial.findByValue(this.scope, "source_path", sourcePath);
    const rows: DocumentRow[] = [];
    for (const node of nodes) {
      const row = await this.#rowOf(node);
      if (row !== null) rows.push(row);
    }
    return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async list(query?: ListDocumentsQuery): Promise<DocumentRow[]> {
    const limit = query?.limit ?? 50;
    const nodes =
      query?.schema_type !== undefined
        ? await this.dial.findByValue(
            this.scope,
            "schema_type",
            query.schema_type,
          )
        : await this.dial.findByValue(this.scope, "hasType", "Note");
    const rows: DocumentRow[] = [];
    for (const node of nodes) {
      const row = await this.#rowOf(node);
      if (row !== null) rows.push(row);
      if (rows.length >= limit * 2) break; // bound the reconstruction work
    }
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const capped = rows.slice(0, limit);
    return query?.omit_body === true
      ? capped.map((r) => ({ ...r, body_text: "" }))
      : capped;
  }

  async listSourcePaths(): Promise<string[]> {
    const nodes = await this.dial.findByValue(this.scope, "hasType", "Note");
    const out = new Set<string>();
    for (const node of nodes) {
      const edges = await this.dial.edges(node);
      const path = edges.find(
        (e) => e.predicate === "source_path" && !e.isNode,
      )?.value;
      if (path !== undefined) out.add(path);
    }
    return [...out].sort();
  }
}
