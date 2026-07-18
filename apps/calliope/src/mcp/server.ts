/**
 * Calliope-MCP server — registers the four prose-facet tools on an
 * {@link McpServer} over a {@link BodyClient}.
 *
 * The prose facet (this MCP) is the peer of clotho's work/graph facet: clotho
 * builds the plan graph (board CRUD on nodes); Calliope-MCP writes the plan
 * prose — the node *bodies* (`note --hasPart--> section --text/order_key-->`) —
 * on those same nodes. Tool shapes mirror clotho's conceptually (read / write /
 * append / edit), not its Python stack.
 *
 * Tools:
 *  - read_body(node_id)                       — resolve a node's sections
 *  - write_body(node_id, sections)            — coarse-save (replace the body)
 *  - append_section(node_id, text)            — append one section at the end
 *  - edit_section(node_id, section_id, text)  — single-section copy-on-write
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BodyClient } from "../types.js";
import type { DocumentStore } from "../document-store.js";
import type { RevisionStore } from "../revision-store.js";
import {
  appendSection,
  applySectionOps,
  editSection,
  readBody,
  readBodyAt,
  readBodyRevisions,
  writeBody,
} from "./tools.js";
import { readPlan, isReadPlanError } from "./plan-ingest.js";

/**
 * Adapt a typed tool result to the MCP SDK's `structuredContent` slot, which
 * is typed as an index-signature record. A named interface result is not
 * structurally a `Record<string, unknown>` (no implicit index signature), so
 * copy it into a fresh record at the boundary.
 */
function structured(result: object): Record<string, unknown> {
  return { ...result };
}

/** Optional extra facets a server can carry beside the body verbs. */
export interface ServerOptions {
  /**
   * The document store (C3, the prose strangle). When present, the server
   * additionally registers `write_document` + `read_documents` — the dissolve
   * sink the monolith's typed-write surface strangled onto the star.
   */
  documents?: DocumentStore;
  /**
   * The revision store (C4). When present, the server additionally registers
   * `file_revisions` + `revision_deltas` — the git-for-ideas archive
   * re-homed from the monolith (frozen history; blob shas stay pointers
   * into the vault's own git repo).
   */
  revisions?: RevisionStore;
}

/** Build a configured MCP server bound to `client`, ready to `connect()`. */
export function createServer(
  client: BodyClient,
  options?: ServerOptions,
): McpServer {
  const server = new McpServer({
    name: "calliope-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "read_body",
    {
      title: "Read node body",
      description:
        "Resolve a plan node's body — its prose sections, sorted by order key. " +
        "Returns { sections: [{ id, text, orderKey }] }; a node with no body " +
        "returns an empty list.",
      inputSchema: {
        node_id: z.string().describe("The node whose body to read."),
      },
    },
    async ({ node_id }) => {
      const result = await readBody(client, node_id);
      return {
        content: [
          {
            type: "text",
            text: `${String(result.sections.length)} section(s).`,
          },
        ],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "write_body",
    {
      title: "Write node body (coarse save)",
      description:
        "Replace a plan node's whole body with the given sections, in display " +
        "order. The substrate mints fresh order keys and copy-on-writes changed " +
        "prose. Returns { ok, count }.",
      inputSchema: {
        node_id: z.string().describe("The node whose body to replace."),
        sections: z
          .array(z.object({ text: z.string() }))
          .describe("The new sections, in display order."),
      },
    },
    async ({ node_id, sections }) => {
      const result = await writeBody(client, node_id, sections);
      return {
        content: [
          { type: "text", text: `Saved ${String(result.count)} section(s).` },
        ],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "append_section",
    {
      title: "Append a section",
      description:
        "Append one new section to the end of a plan node's body. Returns the " +
        "appended { section } and the new body { count }.",
      inputSchema: {
        node_id: z.string().describe("The node to append to."),
        text: z.string().describe("The new section's prose."),
      },
    },
    async ({ node_id, text }) => {
      const result = await appendSection(client, node_id, text);
      return {
        content: [
          {
            type: "text",
            text: `Appended; body now has ${String(result.count)} section(s).`,
          },
        ],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "edit_section",
    {
      title: "Edit one section",
      description:
        "Replace the prose of a single section (copy-on-write), keeping its " +
        "position and every other section untouched. Returns the edited " +
        "{ section }.",
      inputSchema: {
        node_id: z.string().describe("The node owning the section."),
        section_id: z.string().describe("The section to edit."),
        text: z.string().describe("The section's new prose."),
      },
    },
    async ({ node_id, section_id, text }) => {
      const result = await editSection(client, node_id, section_id, text);
      return {
        content: [
          { type: "text", text: `Edited section ${result.section.id}.` },
        ],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "apply_section_ops",
    {
      title: "Apply block-grain section ops",
      description:
        "A11: apply the editor's block-op batch in ONE transaction — add " +
        "(caller-minted fractional order_key), update (copy-on-write, key " +
        "kept unless order_key is supplied), delete, reorder. ALL ops apply " +
        "or none; a stale section_id rejects the whole batch " +
        "(stale_section) — the compare-before-write race backstop. Returns " +
        "{ sections, applied } (applied aligned to the ops array).",
      inputSchema: {
        node_id: z.string().describe("The node whose body the ops target."),
        ops: z
          .array(
            z.discriminatedUnion("op", [
              z.object({
                op: z.literal("add"),
                text: z.string().describe("The new block's prose."),
                order_key: z
                  .string()
                  .min(1)
                  .describe(
                    "Caller-minted fractional key (between neighbors).",
                  ),
              }),
              z.object({
                op: z.literal("update"),
                section_id: z.string().describe("The section to rewrite."),
                text: z.string().describe("The section's new prose."),
                order_key: z
                  .string()
                  .min(1)
                  .optional()
                  .describe("Optional new key (an edit+move in one gesture)."),
              }),
              z.object({
                op: z.literal("delete"),
                section_id: z.string().describe("The section to remove."),
              }),
              z.object({
                op: z.literal("reorder"),
                section_id: z.string().describe("The section to move."),
                order_key: z
                  .string()
                  .min(1)
                  .describe("The new fractional key (between neighbors)."),
              }),
            ]),
          )
          .min(1)
          .describe(
            "The op batch, in apply order; at most one op per section.",
          ),
      },
    },
    async ({ node_id, ops }) => {
      const result = await applySectionOps(client, node_id, ops);
      return {
        content: [
          {
            type: "text",
            text: `Applied ${String(ops.length)} op(s); body now ${String(
              result.sections.length,
            )} section(s).`,
          },
        ],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "read_body_revisions",
    {
      title: "List a body's revisions",
      description:
        "List a plan node body's stored write-events (copy-on-write lineage), " +
        "newest first — each coarse save and each single-section edit is one " +
        "event. Returns { revisions: [{ revision, kind, authoredBy, " +
        "sections }] }. Read-only.",
      inputSchema: {
        node_id: z.string().describe("The node whose history to list."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max events to return (default 50, newest first)."),
      },
    },
    async ({ node_id, limit }) => {
      const result = await readBodyRevisions(client, node_id, limit);
      return {
        content: [
          {
            type: "text",
            text: `${String(result.revisions.length)} revision(s).`,
          },
        ],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "read_body_at",
    {
      title: "Read a body at a revision",
      description:
        "Reconstruct a plan node's body as it stood at a write-event returned " +
        "by read_body_revisions. Returns { revision, sections }; a revision " +
        "predating the body returns an empty list. Read-only.",
      inputSchema: {
        node_id: z.string().describe("The node whose body to reconstruct."),
        revision: z
          .string()
          .describe("The write-event timestamp (from read_body_revisions)."),
      },
    },
    async ({ node_id, revision }) => {
      const result = await readBodyAt(client, node_id, revision);
      return {
        content: [
          {
            type: "text",
            text: `${String(result.sections.length)} section(s) at ${result.revision}.`,
          },
        ],
        structuredContent: structured(result),
      };
    },
  );

  const documents = options?.documents;
  if (documents !== undefined) {
    server.registerTool(
      "write_document",
      {
        title: "Write a dissolved document",
        description:
          "Store one dissolved vault note's body verbatim (the typed-write " +
          "dissolve sink, strangled from phdb). Dedup key is (source_path, " +
          "raw_hash) — an identical re-submit is a no-op. Returns " +
          "{ ok, table, id, deduped }.",
        inputSchema: {
          source_path: z
            .string()
            .describe("The note's vault-relative source path."),
          body_text: z.string().describe("The note body, stored verbatim."),
          schema_type: z
            .string()
            .optional()
            .describe("Schema.org @type (default DigitalDocument)."),
          subject: z.string().optional().describe("The note's title."),
          file_path: z
            .string()
            .optional()
            .describe("Absolute file path at dissolve time."),
          mtime: z
            .string()
            .optional()
            .describe("Frontmatter `updated` (ISO-8601), provenance."),
          ctime: z
            .string()
            .optional()
            .describe("Frontmatter `created` (ISO-8601), provenance."),
          source_kind: z
            .string()
            .optional()
            .describe("Capture-kind tag (default vault-note)."),
          raw_hash: z
            .string()
            .optional()
            .describe("Dedup hash override (default sha256(body_text))."),
        },
      },
      async (input) => {
        const result = await documents.write(input);
        return {
          content: [
            {
              type: "text",
              text: result.deduped
                ? `Deduped (already stored): ${input.source_path}`
                : `Stored document #${String(result.id ?? 0)}.`,
            },
          ],
          structuredContent: structured(result),
        };
      },
    );

    server.registerTool(
      "read_documents",
      {
        title: "Read dissolved documents",
        description:
          "Read the document store: by id, by source_path, or list " +
          "(schema_type filter, newest first). Returns { documents: [...] }.",
        inputSchema: {
          id: z.number().int().optional().describe("A single document id."),
          source_path: z
            .string()
            .optional()
            .describe("All versions stored for one source path."),
          schema_type: z
            .string()
            .optional()
            .describe("List filter: Schema.org @type."),
          limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("List cap (default 50)."),
          omit_body: z
            .boolean()
            .optional()
            .describe("List mode: skip body_text (index-style)."),
        },
      },
      async ({ id, source_path, schema_type, limit, omit_body }) => {
        let rows;
        if (id !== undefined) {
          const row = await documents.byId(id);
          rows = row === null ? [] : [row];
        } else if (source_path !== undefined) {
          rows = await documents.bySourcePath(source_path);
        } else {
          rows = await documents.list({
            ...(schema_type !== undefined ? { schema_type } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(omit_body !== undefined ? { omit_body } : {}),
          });
        }
        return {
          content: [
            { type: "text", text: `${String(rows.length)} document(s).` },
          ],
          structuredContent: { documents: rows },
        };
      },
    );

    server.registerTool(
      "read_plan",
      {
        title: "Read a plan by reference (block-addressable)",
        description:
          "C7 projection-shaped ingest: resolve a plan document BY REFERENCE " +
          "(a handle — `document` id or `source_path`, newest version wins) and " +
          "serve it block-granular, so a prose->graph consumer (athena " +
          "orchestrate_plan) never loads the whole plan_text into its context. " +
          "Whole-plan read (no `block`): returns { handle, title, block_count, " +
          "blocks:[{id,title,size,order}], body_text? } — the feature-block index " +
          "(the addresses) plus the body unless omit_body. Single-block read " +
          "(`block` = a feature id like C7): returns { handle, block:{id,title," +
          "size,order,text} } — just that feature's markdown; the block ref is a " +
          "Calliope handle a conflict payload can return. Misses are structured: " +
          "document_not_found / block_not_found.",
        inputSchema: {
          document: z
            .number()
            .int()
            .optional()
            .describe("The plan document id (the primary handle)."),
          source_path: z
            .string()
            .optional()
            .describe(
              "The plan's source path (resolves to the newest version).",
            ),
          block: z
            .string()
            .optional()
            .describe("A feature-id block address (e.g. C7) — serve just it."),
          omit_body: z
            .boolean()
            .optional()
            .describe("Whole-plan read: omit body_text (index-only)."),
        },
      },
      async ({ document, source_path, block, omit_body }) => {
        const result = await readPlan(documents, {
          ...(document !== undefined ? { document } : {}),
          ...(source_path !== undefined ? { source_path } : {}),
          ...(block !== undefined ? { block } : {}),
          ...(omit_body !== undefined ? { omit_body } : {}),
        });
        if (isReadPlanError(result)) {
          return {
            content: [
              { type: "text", text: `${result.error}: ${result.detail}` },
            ],
            structuredContent: structured(result),
            isError: true,
          };
        }
        const summary =
          "block" in result
            ? `Block ${result.block.id} (${String(result.block.text.length)} chars).`
            : `${String(result.block_count)} feature block(s).`;
        return {
          content: [{ type: "text", text: summary }],
          structuredContent: structured(result),
        };
      },
    );
  }

  const revisions = options?.revisions;
  if (revisions !== undefined) {
    server.registerTool(
      "file_revisions",
      {
        title: "Read the file-revision archive",
        description:
          "The git-for-ideas archive (frozen history, re-homed from phdb): " +
          "revisions by file_path / repo / id, newest first. Blob shas are " +
          "pointers into the vault's git repo. Returns { revisions: [...] }.",
        inputSchema: {
          id: z.number().int().optional().describe("A single revision id."),
          file_path: z
            .string()
            .optional()
            .describe("Vault-relative path filter."),
          repo: z.string().optional().describe("Repo filter."),
          limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Row cap (default 50)."),
        },
      },
      async ({ id, file_path, repo, limit }) => {
        const rows = await revisions.revisions({
          ...(id !== undefined ? { id } : {}),
          ...(file_path !== undefined ? { file_path } : {}),
          ...(repo !== undefined ? { repo } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return {
          content: [
            { type: "text", text: `${String(rows.length)} revision(s).` },
          ],
          structuredContent: { revisions: rows },
        };
      },
    );

    server.registerTool(
      "revision_deltas",
      {
        title: "Read a revision's triple deltas",
        description:
          "The frontmatter/link evolution record for one revision — " +
          "denormalized (subject, predicate, object) labels, in stored " +
          "order. Returns { deltas: [...] }.",
        inputSchema: {
          revision_id: z
            .number()
            .int()
            .describe("The revision whose deltas to read."),
        },
      },
      async ({ revision_id }) => {
        const rows = await revisions.deltasFor(revision_id);
        return {
          content: [{ type: "text", text: `${String(rows.length)} delta(s).` }],
          structuredContent: { deltas: rows },
        };
      },
    );
  }

  return server;
}
