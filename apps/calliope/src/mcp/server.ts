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
 * Tools (F3 — the block grain is the primary surface):
 *  - create_block / read_block / update_block / delete_block — block CRUD
 *  - split_block / merge_block                — identity-preserving structure
 *  - read_body(node_id)                       — resolve a container's blocks
 *  - write_body(node_id, sections)            — LEGACY coarse-save
 *  - append_section / edit_section / apply_section_ops — the editor's batch path
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BodyClient } from "../types.js";
import type { DocumentStore } from "../document-store.js";
import type { RevisionStore } from "../revision-store.js";
import {
  appendSection,
  applySectionOps,
  createBlock,
  deleteBlock,
  editSection,
  isBlockMiss,
  listContainerBlocks,
  mergeBlock,
  readBlock,
  readBody,
  readBodyAt,
  readBodyRevisions,
  splitBlock,
  updateBlock,
  writeBody,
} from "./tools.js";
import { readPlan, isReadPlanError } from "./plan-ingest.js";
import { sinkNoteVersion, type SinkResult } from "../notes-sink.js";
import {
  createNote,
  isCreateNoteError,
  listByTag,
  listTags,
  maybeReconcileInlineTags,
} from "./tools.js";
import type { ChaosFacet } from "../chaos-client.js";
import type { TagStore } from "../tag-store.js";

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
  /**
   * The graph-write muscle (C8). When present, the server additionally
   * registers `create_note` — the note-native gated mint on the notes graph.
   */
  chaos?: ChaosFacet;
  /**
   * The tag mirror (C9). With the chaos facet, additionally registers
   * `list_by_tag` + `list_tags` and arms the body-write inline-tag
   * reconcile + create_note's explicit tags.
   */
  tags?: TagStore;
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

  // C9: the inline-tag reconcile — fires after any successful body write
  // when the chaos facet + tag mirror are wired. Non-fatal: a tag failure
  // never fails the body write it rides behind (logged loudly instead).
  const afterBodyWrite = async (nodeId: string): Promise<void> => {
    if (options?.chaos === undefined || options.tags === undefined) {
      return;
    }
    try {
      await maybeReconcileInlineTags(
        client,
        options.chaos.dial,
        options.chaos.scope,
        options.tags,
        nodeId,
      );
    } catch (err) {
      console.error(
        `calliope-mcp: inline-tag reconcile failed for ${nodeId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  };

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

  // ── F3: the block-native verb surface — the primary grain ────────────────

  server.registerTool(
    "create_block",
    {
      title: "Create a block",
      description:
        "F3: mint ONE block into a container — after the named sibling, or " +
        "appended at the end when no position is given. The fractional order " +
        "key is minted server-side; siblings' ids and keys never move. " +
        "Returns { block: { id, text, orderKey } }. A stale after_block_id " +
        "rejects with stale_section.",
      inputSchema: {
        container_id: z
          .string()
          .describe("The container (note/document node) to create into."),
        text: z.string().describe("The new block's prose."),
        after_block_id: z
          .string()
          .optional()
          .describe("Insert after this block; omitted = append at the end."),
      },
    },
    async ({ container_id, text, after_block_id }) => {
      const result = await createBlock(
        client,
        container_id,
        text,
        after_block_id,
      );
      await afterBodyWrite(container_id);
      return {
        content: [{ type: "text", text: `Created block ${result.block.id}.` }],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "read_block",
    {
      title: "Read one block",
      description:
        "F3/F5: serve ONE block's content — only that block's markdown " +
        "crosses the wire. Two handle families: { container_id, block_id } " +
        "reads a section-store block (returns { block: { id, text, " +
        "orderKey } }); { document | source_path, block_id } reads one " +
        "feature block of a stored plan document (returns { handle, block: " +
        "{ id, title, size, order, text } }). Misses are structured: " +
        "block_not_found / document_not_found / bad_handle.",
      inputSchema: {
        container_id: z
          .string()
          .optional()
          .describe("Node family: the container owning the block."),
        block_id: z.string().describe("The block to read (or a feature id)."),
        document: z
          .number()
          .int()
          .optional()
          .describe("Document family: the plan document id."),
        source_path: z
          .string()
          .optional()
          .describe("Document family: the plan's source path (newest wins)."),
      },
    },
    async ({ container_id, block_id, document, source_path }) => {
      if (container_id !== undefined) {
        const result = await readBlock(client, container_id, block_id);
        if (isBlockMiss(result)) {
          return {
            content: [
              { type: "text", text: `${result.error}: ${result.detail}` },
            ],
            structuredContent: structured(result),
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Block ${result.block.id} (${String(result.block.text.length)} chars).`,
            },
          ],
          structuredContent: structured(result),
        };
      }
      const documents = options?.documents;
      if (
        (document === undefined && source_path === undefined) ||
        documents === undefined
      ) {
        const miss = {
          error: "bad_handle",
          detail:
            documents === undefined &&
            (document !== undefined || source_path !== undefined)
              ? "this backend carries no document store"
              : "read_block needs a container_id, or a document/source_path.",
        };
        return {
          content: [{ type: "text", text: `${miss.error}: ${miss.detail}` }],
          structuredContent: structured(miss),
          isError: true,
        };
      }
      const result = await readPlan(documents, {
        ...(document !== undefined ? { document } : {}),
        ...(source_path !== undefined ? { source_path } : {}),
        block: block_id,
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
          : "unexpected whole-plan result";
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "list_blocks",
    {
      title: "List a container's blocks (the index)",
      description:
        "F5: the general container index — block ids, titles, sizes and " +
        "order, with NO body text crossing the wire. Two handle families: " +
        "{ container_id } serves a section container (entries { id, title, " +
        "chars, order_key }, kind: 'node'); { document | source_path } " +
        "serves a stored plan document's feature-block index (entries " +
        "{ id, title, size, order }, kind: 'document'). This is the read " +
        "that replaces read_plan's whole-plan index.",
      inputSchema: {
        container_id: z
          .string()
          .optional()
          .describe("Node family: the section container."),
        document: z
          .number()
          .int()
          .optional()
          .describe("Document family: the plan document id."),
        source_path: z
          .string()
          .optional()
          .describe("Document family: the plan's source path (newest wins)."),
      },
    },
    async ({ container_id, document, source_path }) => {
      if (container_id !== undefined) {
        const result = await listContainerBlocks(client, container_id);
        return {
          content: [
            {
              type: "text",
              text: `${String(result.block_count)} block(s) in ${container_id}.`,
            },
          ],
          structuredContent: structured(result),
        };
      }
      const documents = options?.documents;
      if (
        (document === undefined && source_path === undefined) ||
        documents === undefined
      ) {
        const miss = {
          error: "bad_handle",
          detail:
            documents === undefined &&
            (document !== undefined || source_path !== undefined)
              ? "this backend carries no document store"
              : "list_blocks needs a container_id, or a document/source_path.",
        };
        return {
          content: [{ type: "text", text: `${miss.error}: ${miss.detail}` }],
          structuredContent: structured(miss),
          isError: true,
        };
      }
      const result = await readPlan(documents, {
        ...(document !== undefined ? { document } : {}),
        ...(source_path !== undefined ? { source_path } : {}),
        omit_body: true,
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
      if ("block" in result) {
        // Unreachable: no block address was passed.
        throw new Error("list_blocks: unexpected single-block result");
      }
      const index = {
        kind: "document" as const,
        handle: result.handle,
        title: result.title,
        block_count: result.block_count,
        blocks: result.blocks,
      };
      return {
        content: [
          {
            type: "text",
            text: `${String(index.block_count)} feature block(s).`,
          },
        ],
        structuredContent: structured(index),
      };
    },
  );

  server.registerTool(
    "update_block",
    {
      title: "Update one block",
      description:
        "F3: rewrite ONE block's prose (copy-on-write — exactly one " +
        "superseding row; the container's other blocks are untouched and " +
        "shared by reference). The block's position is kept. Returns " +
        "{ block }. A stale block_id rejects.",
      inputSchema: {
        container_id: z.string().describe("The container owning the block."),
        block_id: z.string().describe("The block to rewrite."),
        text: z.string().describe("The block's new prose."),
      },
    },
    async ({ container_id, block_id, text }) => {
      const result = await updateBlock(client, container_id, block_id, text);
      await afterBodyWrite(container_id);
      return {
        content: [{ type: "text", text: `Updated block ${result.block.id}.` }],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "delete_block",
    {
      title: "Delete one block",
      description:
        "F3: remove ONE block from its container. History preserves it — " +
        "as-of reconstruction still shows the block before the delete. " +
        "Returns { ok, deleted: { id, orderKey } }. A stale block_id rejects.",
      inputSchema: {
        container_id: z.string().describe("The container owning the block."),
        block_id: z.string().describe("The block to remove."),
      },
    },
    async ({ container_id, block_id }) => {
      const result = await deleteBlock(client, container_id, block_id);
      await afterBodyWrite(container_id);
      return {
        content: [
          { type: "text", text: `Deleted block ${result.deleted.id}.` },
        ],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "split_block",
    {
      title: "Split a block (identity-preserving)",
      description:
        "F3: cut one block at a caret offset (UTF-16 units; 0..length — " +
        "boundary splits make an empty block) into TWO blocks whose order " +
        "keys land between the original's neighbours. BOTH children record " +
        "the original as lineage predecessor, so comments/pins/anchors " +
        "resolve forward. Returns { blocks: [first, second] }.",
      inputSchema: {
        container_id: z.string().describe("The container owning the block."),
        block_id: z.string().describe("The block to split."),
        offset: z
          .number()
          .int()
          .min(0)
          .describe("The caret offset (UTF-16 code units into the text)."),
      },
    },
    async ({ container_id, block_id, offset }) => {
      const result = await splitBlock(client, container_id, block_id, offset);
      await afterBodyWrite(container_id);
      return {
        content: [
          {
            type: "text",
            text: `Split into ${result.blocks[0].id} + ${result.blocks[1].id}.`,
          },
        ],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "merge_block",
    {
      title: "Merge two adjacent blocks (identity-preserving)",
      description:
        "F3: join a block with its immediate successor into ONE block " +
        "(first + separator + second, at the first's position). The " +
        "survivor's lineage records BOTH parents (the supersessions join " +
        "table), so anchors on either resolve forward. Non-adjacent pairs " +
        "reject with not_adjacent; stale ids with stale_section. Returns " +
        "{ block }.",
      inputSchema: {
        container_id: z.string().describe("The container owning the blocks."),
        first_block_id: z
          .string()
          .describe("The earlier block (keeps its position)."),
        second_block_id: z
          .string()
          .describe("Its immediate successor (merged into the first)."),
        separator: z
          .string()
          .optional()
          .describe("Joined between the two texts (default: none)."),
      },
    },
    async ({ container_id, first_block_id, second_block_id, separator }) => {
      const result = await mergeBlock(
        client,
        container_id,
        first_block_id,
        second_block_id,
        separator,
      );
      await afterBodyWrite(container_id);
      return {
        content: [{ type: "text", text: `Merged into ${result.block.id}.` }],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "write_body",
    {
      title: "Write node body (LEGACY coarse save)",
      description:
        "LEGACY (F3): the whole-body replace. Prefer the block verbs " +
        "(create_block / update_block / delete_block / split_block / " +
        "merge_block) — they preserve block identity; this replaces every " +
        "block's id in one stroke. Kept for coarse imports and the editor's " +
        "degraded path. Returns { ok, count }.",
      inputSchema: {
        node_id: z.string().describe("The node whose body to replace."),
        sections: z
          .array(z.object({ text: z.string() }))
          .describe("The new sections, in display order."),
      },
    },
    async ({ node_id, sections }) => {
      const result = await writeBody(client, node_id, sections);
      await afterBodyWrite(node_id);
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
      await afterBodyWrite(node_id);
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
      await afterBodyWrite(node_id);
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
      await afterBodyWrite(node_id);
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
        // F6 — the strangler bridge: while the table remains the READ truth
        // (until F7 cuts over), every dissolve ALSO lands note-natively —
        // identity + one-block container + provenance attrs + tags. Both
        // halves are idempotent, so a failed-then-retried dissolve
        // converges; a sink failure fails the verb (silent loss = silent
        // drift between the stores).
        let note: SinkResult | undefined;
        if (options?.chaos !== undefined) {
          note = await sinkNoteVersion(
            client,
            options.chaos.dial,
            options.chaos.scope,
            options.tags,
            input,
          );
        }
        return {
          content: [
            {
              type: "text",
              text:
                (result.deduped
                  ? `Deduped (already stored): ${input.source_path}`
                  : `Stored document #${String(result.id ?? 0)}.`) +
                (note !== undefined
                  ? ` Note ${note.node_id} (${note.generation}).`
                  : ""),
            },
          ],
          structuredContent: structured(
            note === undefined ? result : { ...result, note },
          ),
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
        title:
          "Read a plan by reference (LEGACY — prefer list_blocks + read_block)",
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

  if (options?.chaos !== undefined) {
    const { dial, scope } = options.chaos;
    server.registerTool(
      "create_note",
      {
        title: "Create a note (the note-native mint)",
        description:
          "C8: mint a Note-kind identity node on the notes graph through the " +
          "gated two-admit path (createNode, then hasName/hasType/parent " +
          "edges), auto-parenting to the invisible 'Notes' root when no " +
          "parent is named — orphan-safe, idempotent on (Note, title), with " +
          "heal-on-reuse for interrupted mints. tags[] is accepted and " +
          "forward-carried (the hasTag write is C9's). Returns {node_id, " +
          "created}; misses are structured (bad_title / bad_parent / " +
          "bad_tags / admit_refused).",
        inputSchema: {
          title: z
            .string()
            .min(1)
            .describe("The note's title — its graph name AND idempotency key."),
          parent: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional()
            .describe(
              "Parent node token; omitted, the note parents to the ensured " +
                "'Notes' root.",
            ),
          tags: z
            .array(z.string())
            .optional()
            .describe(
              "Explicit tags (e.g. folder-derived) — validated here, written " +
                "as hasTag edges by C9.",
            ),
        },
      },
      async ({ title, parent, tags }) => {
        const result = await createNote(
          dial,
          scope,
          {
            title,
            ...(parent !== undefined ? { parent } : {}),
            ...(tags !== undefined ? { tags } : {}),
          },
          options.tags,
        );
        if (isCreateNoteError(result)) {
          return {
            content: [
              { type: "text", text: `${result.error}: ${result.detail}` },
            ],
            structuredContent: structured(result),
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `note ${result.node_id} (${result.created ? "created" : "existing"})`,
            },
          ],
          structuredContent: structured(result),
        };
      },
    );
  }

  if (options?.chaos !== undefined && options.tags !== undefined) {
    const { dial, scope } = options.chaos;
    const tagStore = options.tags;
    server.registerTool(
      "list_by_tag",
      {
        title: "Notes carrying a tag",
        description:
          "C9: the server-side tag slice — the notes-graph nodes carrying " +
          "hasTag == the (lowercase-normalized) tag, over the graph's indexed " +
          "point lookup. Returns {tag, node_ids}.",
        inputSchema: {
          tag: z
            .string()
            .min(1)
            .describe("The tag (with or without the leading #)."),
        },
      },
      async ({ tag }) => {
        const result = await listByTag(dial, scope, tag);
        return {
          content: [
            {
              type: "text",
              text: `${String(result.node_ids.length)} note(s) carry ${result.tag}.`,
            },
          ],
          structuredContent: structured(result),
        };
      },
    );

    server.registerTool(
      "list_tags",
      {
        title: "The distinct tag set",
        description:
          "C9: every tag Calliope has written, with carrier counts — the " +
          "picker's chip source. Returns {tags: [{tag, count}]}.",
        inputSchema: {},
      },
      async () => {
        const result = await listTags(tagStore);
        return {
          content: [
            { type: "text", text: `${String(result.tags.length)} tag(s).` },
          ],
          structuredContent: structured(result),
        };
      },
    );
  }

  return server;
}
