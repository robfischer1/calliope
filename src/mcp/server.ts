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
import { appendSection, editSection, readBody, writeBody } from "./tools.js";

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
  }

  return server;
}
