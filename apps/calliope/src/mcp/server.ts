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
import { isAuthoredBy, validateWriteProvenance } from "../types.js";
import type { AuthoredBy, BodyClient } from "../types.js";
import type { DocumentStore } from "../document-store.js";
import type { RevisionStore } from "../revision-store.js";
import {
  appendSection,
  applySectionOps,
  copyReference,
  createBlock,
  createComment,
  deleteBlock,
  editSection,
  listComments,
  isBlockMiss,
  isCopyReferenceError,
  look,
  unpin,
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
import { dissolveContainer, type SinkResult } from "../notes-sink.js";
import type { FocusRegister } from "../focus-register.js";
import {
  createNote,
  isCreateNoteError,
  listByTag,
  listTags,
  maybeReconcileInlineTags,
} from "./tools.js";
import type { ChaosFacet } from "../chaos-client.js";
import { ChaosClientError } from "../chaos-client.js";
import { type ContainerFacet, writeContainer } from "../container-write.js";
import { containerHistory, readContainer } from "../container-read.js";
import type { TagStore } from "../tag-store.js";
import type { SearchProvider, SearchResponse } from "../fs-search/index.js";

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
  /**
   * The focus register (028 — "Look At This" F5). When present, the server
   * additionally registers `look` — the attention-pointer read verb. The
   * register itself is written by the Pontus telemetry consumer the boot
   * wires (`focus-register.ts`); the verb only ever reads.
   */
  focus?: FocusRegister;
  /**
   * The search provider (Findability F2). The `search` verb registers on
   * EVERY backend — a backend with no provider answers honest darkness
   * (no arms queried, both local arms dark) rather than hiding the verb;
   * F4 lights the pg backend by routing its provider at Eros.
   */
  search?: SearchProvider;
  /**
   * The container surface (041 F4 — Git for Ideas). When present, the
   * server registers `write_container` — the tree-native save: blob-first,
   * one graph transaction, identical content nets to nothing.
   */
  containers?: ContainerFacet;
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

  // 024: optional per-call write provenance, shared by every sections-writing
  // verb. Form-only validation — authenticity is the master plan's surfaced
  // open item, not decided here.
  const authoredByField = z
    .string()
    .refine(isAuthoredBy, {
      message:
        'authored_by must be "human", "calliope", or a SPIFFE session ' +
        "principal (spiffe://{trust-domain}/session/{uuid}).",
    })
    .optional()
    .describe(
      'Optional write provenance: "human", "calliope", or a SPIFFE session ' +
        "principal (spiffe://{trust-domain}/session/{uuid}). Absent = the " +
        "backend's default.",
    );
  const asAuthor = (v: string | undefined): AuthoredBy | undefined =>
    v !== undefined && isAuthoredBy(v) ? v : undefined;

  // 025: the session's log offset at the moment of the write. Only valid
  // alongside a session-principal authored_by (validateWriteProvenance in
  // each handler); absent = NULL stored, never a guess.
  const kafkaOffsetField = z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      "Optional session-log position of this write (the session-turns " +
        "offset). Requires a session-principal authored_by on the same " +
        "call; absent = no session context (stored NULL).",
    );

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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
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
        authored_by: authoredByField,
        kafka_offset: kafkaOffsetField,
      },
    },
    async ({
      container_id,
      text,
      after_block_id,
      authored_by,
      kafka_offset,
    }) => {
      validateWriteProvenance(asAuthor(authored_by), kafka_offset);
      const result = await createBlock(
        client,
        container_id,
        text,
        after_block_id,
        asAuthor(authored_by),
        kafka_offset,
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
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
        authored_by: authoredByField,
        kafka_offset: kafkaOffsetField,
      },
    },
    async ({ container_id, block_id, text, authored_by, kafka_offset }) => {
      validateWriteProvenance(asAuthor(authored_by), kafka_offset);
      const result = await updateBlock(
        client,
        container_id,
        block_id,
        text,
        asAuthor(authored_by),
        kafka_offset,
      );
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
      title: "Delete one block",
      description:
        "F3: remove ONE block from its container. History preserves it — " +
        "as-of reconstruction still shows the block before the delete. " +
        "Returns { ok, deleted: { id, orderKey } }. A stale block_id rejects.",
      inputSchema: {
        container_id: z.string().describe("The container owning the block."),
        block_id: z.string().describe("The block to remove."),
        authored_by: authoredByField,
        kafka_offset: kafkaOffsetField,
      },
    },
    async ({ container_id, block_id, authored_by, kafka_offset }) => {
      validateWriteProvenance(asAuthor(authored_by), kafka_offset);
      const result = await deleteBlock(
        client,
        container_id,
        block_id,
        asAuthor(authored_by),
        kafka_offset,
      );
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
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
        authored_by: authoredByField,
        kafka_offset: kafkaOffsetField,
      },
    },
    async ({ container_id, block_id, offset, authored_by, kafka_offset }) => {
      validateWriteProvenance(asAuthor(authored_by), kafka_offset);
      const result = await splitBlock(
        client,
        container_id,
        block_id,
        offset,
        asAuthor(authored_by),
        kafka_offset,
      );
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
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
        authored_by: authoredByField,
        kafka_offset: kafkaOffsetField,
      },
    },
    async ({
      container_id,
      first_block_id,
      second_block_id,
      separator,
      authored_by,
      kafka_offset,
    }) => {
      validateWriteProvenance(asAuthor(authored_by), kafka_offset);
      const result = await mergeBlock(
        client,
        container_id,
        first_block_id,
        second_block_id,
        separator,
        asAuthor(authored_by),
        kafka_offset,
      );
      await afterBodyWrite(container_id);
      return {
        content: [{ type: "text", text: `Merged into ${result.block.id}.` }],
        structuredContent: structured(result),
      };
    },
  );

  // ── 026: comments — the attributed-review surface ────────────────────────

  server.registerTool(
    "create_comment",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      title: "Comment on a block",
      description:
        "026: attach a comment to a block — an ordinary block plus a " +
        "commentsOn edge, landed atomically. Target a comment to reply. " +
        "REQUIRES a session-principal authored_by: sessions comment as " +
        "users, with identity (TURN 258); anonymous and legacy-authored " +
        "comments are refused. The document's own body is untouched. " +
        "Returns { comment, target_id, comment_container_id }.",
      inputSchema: {
        container_id: z
          .string()
          .describe("The DOCUMENT container owning the target block."),
        target_block_id: z
          .string()
          .describe("The block to comment on (or a comment id, to reply)."),
        text: z.string().describe("The comment's prose."),
        authored_by: z
          .string()
          .refine(isAuthoredBy, {
            message:
              'authored_by must be "human", "calliope", or a SPIFFE session ' +
              "principal (spiffe://{trust-domain}/session/{uuid}).",
          })
          .describe(
            "REQUIRED: the commenting session's principal " +
              "(spiffe://{trust-domain}/session/{uuid}).",
          ),
        kafka_offset: kafkaOffsetField,
      },
    },
    async ({
      container_id,
      target_block_id,
      text,
      authored_by,
      kafka_offset,
    }) => {
      const author = asAuthor(authored_by);
      if (author === undefined) {
        // Unreachable past the schema refine; keeps the type narrow honest.
        throw new Error("create_comment: authored_by failed validation.");
      }
      validateWriteProvenance(author, kafka_offset);
      const result = await createComment(
        client,
        container_id,
        target_block_id,
        text,
        author,
        kafka_offset,
      );
      return {
        content: [
          {
            type: "text",
            text: `Comment ${result.comment.id} on ${result.target_id}.`,
          },
        ],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "list_comments",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Read comment threads",
      description:
        "026: read a document's comment threads. With block_id: that " +
        "block's thread, INCLUDING comments made on its lineage " +
        "predecessors (an edit never orphans its review trail); without: " +
        "every thread in the container. Each thread reports its target's " +
        "state (active | superseded | deleted) and each comment's author, " +
        "log offset, and creation stamp. Returns { threads }.",
      inputSchema: {
        container_id: z.string().describe("The DOCUMENT container."),
        block_id: z
          .string()
          .optional()
          .describe("Focus on one block's thread (lineage-following)."),
        resolve_anchors: z
          .boolean()
          .optional()
          .describe(
            "027: also resolve, per comment, the target's prose as the " +
              "commenter saw it (anchorText), its current prose " +
              "(currentText), and a drift flag. Costs a read per comment; " +
              "default false.",
          ),
      },
    },
    async ({ container_id, block_id, resolve_anchors }) => {
      const result = await listComments(
        client,
        container_id,
        block_id,
        resolve_anchors,
      );
      return {
        content: [
          {
            type: "text",
            text: `${String(result.threads.length)} thread(s).`,
          },
        ],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "coalesce_block_writes",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      title: "Coalesce a writing arc's pause-writes (gated)",
      description:
        "F8: collapse one block's intra-arc supersession chain to its " +
        "endpoints — the pre-arc state and the final row — physically " +
        "removing the pause-write intermediates and rewiring lineage across " +
        "the gap, so row growth is bounded by sessions rather than pauses. " +
        "The arc is named by the caller: the final block id plus the " +
        "arc-start revision (from read_body_revisions). Structural events " +
        "(splits, merges, batches) are never collapsed across. OFF BY " +
        "DEFAULT: refuses unless CALLIOPE_COALESCE_ARCS=1. Returns " +
        "{ removed, from, to }.",
      inputSchema: {
        container_id: z.string().describe("The container owning the block."),
        block_id: z.string().describe("The arc's final (active) block."),
        since_revision: z
          .string()
          .describe("The arc-start revision timestamp (pre-arc moment)."),
      },
    },
    async ({ container_id, block_id, since_revision }) => {
      if (process.env.CALLIOPE_COALESCE_ARCS !== "1") {
        const miss = {
          error: "coalesce_disabled",
          detail:
            "arc coalescing is off by default until verified — set " +
            "CALLIOPE_COALESCE_ARCS=1 to enable (master-plan F8).",
        };
        return {
          content: [{ type: "text", text: `${miss.error}: ${miss.detail}` }],
          structuredContent: structured(miss),
          isError: true,
        };
      }
      if (client.coalesceArc === undefined) {
        throw new Error(
          "coalesce_block_writes: the configured body backend does not " +
            "support arc coalescing (no coalesceArc method).",
        );
      }
      const result = await client.coalesceArc(
        container_id,
        block_id,
        since_revision,
      );
      return {
        content: [
          {
            type: "text",
            text: `Removed ${String(result.removed)} intermediate row(s).`,
          },
        ],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "write_body",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
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
        authored_by: authoredByField,
        kafka_offset: kafkaOffsetField,
      },
    },
    async ({ node_id, sections, authored_by, kafka_offset }) => {
      validateWriteProvenance(asAuthor(authored_by), kafka_offset);
      const result = await writeBody(
        client,
        node_id,
        sections,
        asAuthor(authored_by),
        kafka_offset,
      );
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      title: "Append a section",
      description:
        "Append one new section to the end of a plan node's body. Returns the " +
        "appended { section } and the new body { count }.",
      inputSchema: {
        node_id: z.string().describe("The node to append to."),
        text: z.string().describe("The new section's prose."),
        authored_by: authoredByField,
        kafka_offset: kafkaOffsetField,
      },
    },
    async ({ node_id, text, authored_by, kafka_offset }) => {
      validateWriteProvenance(asAuthor(authored_by), kafka_offset);
      const result = await appendSection(
        client,
        node_id,
        text,
        asAuthor(authored_by),
        kafka_offset,
      );
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Edit one section",
      description:
        "Replace the prose of a single section (copy-on-write), keeping its " +
        "position and every other section untouched. Returns the edited " +
        "{ section }.",
      inputSchema: {
        node_id: z.string().describe("The node owning the section."),
        section_id: z.string().describe("The section to edit."),
        text: z.string().describe("The section's new prose."),
        authored_by: authoredByField,
        kafka_offset: kafkaOffsetField,
      },
    },
    async ({ node_id, section_id, text, authored_by, kafka_offset }) => {
      validateWriteProvenance(asAuthor(authored_by), kafka_offset);
      const result = await editSection(
        client,
        node_id,
        section_id,
        text,
        asAuthor(authored_by),
        kafka_offset,
      );
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
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
        authored_by: authoredByField,
        kafka_offset: kafkaOffsetField,
      },
    },
    async ({ node_id, ops, authored_by, kafka_offset }) => {
      validateWriteProvenance(asAuthor(authored_by), kafka_offset);
      const result = await applySectionOps(
        client,
        node_id,
        ops,
        asAuthor(authored_by),
        kafka_offset,
      );
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
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

  server.registerTool(
    "search",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Search bodies",
      description:
        "Findability F2: search(query, scope) — ranked hits with snippets " +
        "over the backend's corpus, RRF-fused across the available arms " +
        "(full-text, semantic, remote). Returns { hits: [{ id, snippet, " +
        "score, arms }], armsQueried, armsDark } — a dark arm is NAMED, " +
        "never hidden; no arms queried + arms dark means the backend has " +
        "no search provider (or no index yet), distinct from zero matches.",
      inputSchema: {
        query: z.string().min(1).describe("The search phrase."),
        scope: z
          .string()
          .optional()
          .describe(
            "Root-relative subtree prefix to restrict to; absent = everything.",
          ),
        k: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max hits to return (default 20)."),
      },
    },
    async ({ query, scope, k }) => {
      const provider = options?.search;
      const result: SearchResponse =
        provider === undefined
          ? { hits: [], armsQueried: [], armsDark: ["fts", "semantic"] }
          : await provider.search(query, scope, k);
      const darkNote =
        result.armsDark.length > 0
          ? ` (dark: ${result.armsDark.join(", ")})`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `${String(result.hits.length)} hit(s)${darkNote}.`,
          },
        ],
        structuredContent: structured(result),
      };
    },
  );

  server.registerTool(
    "has_body",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Bulk prose-presence",
      description:
        "Findability F10: active-block counts for a whole extent in ONE " +
        "call — the browse list badges without N per-node reads (footgun " +
        "#5). Returns { present: [{ node_id, blocks }] }; ids with no body " +
        "are absent from the list. Bounded: at most 2048 ids per call.",
      inputSchema: {
        node_ids: z
          .array(z.string())
          .min(1)
          .max(2048)
          .describe("The extent to check (bounded at 2048 ids)."),
      },
    },
    async ({ node_ids }) => {
      if (client.hasBody === undefined) {
        throw new Error(
          "has_body: the configured body backend does not support bulk " +
            "prose-presence (no hasBody method).",
        );
      }
      const counts = await client.hasBody(node_ids);
      const present = [...counts.entries()].map(([node_id, blocks]) => ({
        node_id,
        blocks,
      }));
      return {
        content: [
          {
            type: "text",
            text: `${String(present.length)} of ${String(node_ids.length)} carry prose.`,
          },
        ],
        structuredContent: structured({ present }),
      };
    },
  );

  const documents = options?.documents;
  if (documents !== undefined) {
    server.registerTool(
      "write_document",
      {
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
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
        // F7 — the strangler finished: the store IS the note-native sink;
        // no table write exists anymore. Fresh dissolves carry no document
        // id (the table's sequence died with it) — source_path is the
        // durable handle; migrated ids resolve via the bridge attributes.
        const result = await documents.write(input);
        const note = (result as { note?: SinkResult }).note;
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
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
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
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
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
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
        title: "Read the file-revision archive",
        description:
          "FROZEN ARCHIVE (F7 scoping): the git-for-ideas record re-homed " +
          "from phdb — read-only history, never a live write surface: " +
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
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
        title: "Read a revision's triple deltas",
        description:
          "FROZEN ARCHIVE (F7 scoping): the frontmatter/link evolution " +
          "record for one revision — " +
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

  // 028 ("Look At This" F5): the attention-pointer read verb — served when
  // the boot wired a focus register. Read-only: N sessions are N readers of
  // one value; the verb never mutates the register.
  if (options?.focus !== undefined) {
    const register = options.focus;
    server.registerTool(
      "look",
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
        title: "Read the focus register",
        description:
          "028/F5: the attention pointer — the current focus Rob's editor " +
          "last emitted (a capture-time-resolved block pointer), with an " +
          "honest drift verdict against the live block: none / drifted " +
          "(current_text included) / gone. No focus yet answers " +
          "{ focus: null }, not an error. Reading never mutates.",
        inputSchema: {},
      },
      async () => {
        const result = await look(client, register);
        return {
          content: [
            {
              type: "text",
              text:
                (result.focus === null
                  ? "no focus"
                  : `${result.focus.pointer.node} · ${result.focus.pointer.section} · drift: ${result.focus.drift}`) +
                ` · ${String(result.pins.length)} pin(s)`,
            },
          ],
          structuredContent: structured(result),
        };
      },
    );

    server.registerTool(
      "unpin",
      {
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        },
        title: "Remove one pin",
        description:
          "029/F6: clear one deliberate pin by its pin_id (as answered in " +
          "look's pins[]). The conversational 'clear pin 2'. Unknown id " +
          "answers a structured unknown_pin miss; live focus is untouched.",
        inputSchema: {
          pin_id: z.string().min(1).describe("The pin to remove."),
        },
      },
      ({ pin_id }) => {
        const result = unpin(register, pin_id);
        const missed = "error" in result;
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: missed
                ? `${result.error}: ${result.detail}`
                : `unpinned ${result.pin_id}`,
            },
          ],
          structuredContent: structured(result),
          ...(missed ? { isError: true } : {}),
        });
      },
    );
  }

  if (options?.chaos !== undefined) {
    const { dial, scope } = options.chaos;

    server.registerTool(
      "dissolve_note",
      {
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
        title: "Dissolve — promote one container into the constellation",
        description:
          "F9: per-note promotion, human-chosen (the inversion that retired " +
          "C6's bulk sweep). Lands the container's blocks as ONE generation " +
          "on its note (identity = source_path, the F6 key), reconciles the " +
          "provenance attributes and materialises inline tags as hasTag " +
          "edges. Identical content is a no-op; changed content is a " +
          "superseding generation — history keeps the old (last-write-wins " +
          "under append-only history). Returns { node_id, created, " +
          "generation }.",
        inputSchema: {
          source_path: z
            .string()
            .min(1)
            .describe("The container's local path — its stable identity."),
          blocks: z
            .array(z.object({ text: z.string() }))
            .describe("The container's blocks, in display order."),
          title: z.string().optional().describe("The display title."),
          source_kind: z
            .string()
            .optional()
            .describe("Capture-kind provenance (default vault-note)."),
          mtime: z.string().optional().describe("Local modified time."),
          ctime: z.string().optional().describe("Local created time."),
          raw_hash: z
            .string()
            .optional()
            .describe("The local file's content hash (default: derived)."),
        },
      },
      async ({
        source_path,
        blocks,
        title,
        source_kind,
        mtime,
        ctime,
        raw_hash,
      }) => {
        const result = await dissolveContainer(
          client,
          dial,
          scope,
          options.tags,
          {
            source_path,
            blocks: blocks.map((b) => b.text),
            ...(title !== undefined ? { title } : {}),
            ...(source_kind !== undefined ? { source_kind } : {}),
            ...(mtime !== undefined ? { mtime } : {}),
            ...(ctime !== undefined ? { ctime } : {}),
            ...(raw_hash !== undefined ? { raw_hash } : {}),
          },
        );
        return {
          content: [
            {
              type: "text",
              text: `Dissolved ${source_path} -> note ${result.node_id} (${result.generation}).`,
            },
          ],
          structuredContent: structured(result),
        };
      },
    );

    server.registerTool(
      "export_note",
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
        title: "Export a container to markdown (one-way)",
        description:
          "F14 (the A5 fork closes): project a container's blocks to clean " +
          "markdown for git and grep — blocks byte-verbatim, in order, " +
          "joined with the dialect's block separator. Markdown is an " +
          "EXPORT here, never the interchange format or the source of " +
          "truth. Handle: container_id, or source_path (the note's " +
          "identity name). Returns { container_id, markdown, block_count }; " +
          "a miss is container_not_found.",
        inputSchema: {
          container_id: z.string().optional().describe("The note's node id."),
          source_path: z
            .string()
            .optional()
            .describe("The note's identity path (resolves by name)."),
        },
      },
      async ({ container_id, source_path }) => {
        let nodeId = container_id;
        if (nodeId === undefined && source_path !== undefined) {
          const [hit] = await dial.findByName("Note", source_path);
          nodeId = hit;
        }
        const body = nodeId === undefined ? [] : await client.readBody(nodeId);
        if (nodeId === undefined || body.length === 0) {
          const miss = {
            error: "container_not_found",
            detail:
              container_id ??
              source_path ??
              "export_note needs a container_id or a source_path",
          };
          return {
            content: [{ type: "text", text: `${miss.error}: ${miss.detail}` }],
            structuredContent: structured(miss),
            isError: true,
          };
        }
        const markdown = body.map((s) => s.text).join("\n\n");
        const result = {
          container_id: nodeId,
          markdown,
          block_count: body.length,
        };
        return {
          content: [
            {
              type: "text",
              text: `${String(body.length)} block(s), ${String(markdown.length)} chars.`,
            },
          ],
          structuredContent: structured(result),
        };
      },
    );

    server.registerTool(
      "materialize_note",
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
        title: "Materialize — land a remote container locally",
        description:
          "F9: the inverse of Dissolve — one read serving everything the " +
          "local window needs to write the file: the blocks in order, the " +
          "tags, and the provenance attributes. Handle: container_id, or " +
          "source_path (the note's identity name). A miss is a structured " +
          "container_not_found.",
        inputSchema: {
          container_id: z.string().optional().describe("The note's node id."),
          source_path: z
            .string()
            .optional()
            .describe("The note's identity path (resolves by name)."),
        },
      },
      async ({ container_id, source_path }) => {
        let nodeId = container_id;
        if (nodeId === undefined && source_path !== undefined) {
          const [hit] = await dial.findByName("Note", source_path);
          nodeId = hit;
        }
        const edges = nodeId === undefined ? [] : await dial.edges(nodeId);
        if (nodeId === undefined || edges.length === 0) {
          const miss = {
            error: "container_not_found",
            detail:
              container_id ??
              source_path ??
              "materialize_note needs a container_id or a source_path",
          };
          return {
            content: [{ type: "text", text: `${miss.error}: ${miss.detail}` }],
            structuredContent: structured(miss),
            isError: true,
          };
        }
        const body = await client.readBody(nodeId);
        const tags = edges
          .filter((e) => e.predicate === "hasTag" && !e.isNode)
          .map((e) => e.value);
        const PROVENANCE = [
          "source_path",
          "raw_hash",
          "source_kind",
          "mtime",
          "ctime",
          "title",
          "schema_type",
          "file_path",
          "dissolved_at",
        ];
        const provenance: Record<string, string> = {};
        for (const e of edges) {
          if (!e.isNode && PROVENANCE.includes(e.predicate)) {
            provenance[e.predicate] = e.value;
          }
        }
        const result = {
          container_id: nodeId,
          blocks: body.map((s) => ({
            id: s.id,
            text: s.text,
            orderKey: s.orderKey,
          })),
          tags,
          provenance,
        };
        return {
          content: [
            {
              type: "text",
              text: `${String(result.blocks.length)} block(s), ${String(tags.length)} tag(s).`,
            },
          ],
          structuredContent: structured(result),
        };
      },
    );

    server.registerTool(
      "create_note",
      {
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
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

    server.registerTool(
      "copy_reference",
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
        title: "Compound copy-reference",
        description:
          "024/F1: the compound reference for a note — a human-readable " +
          "wikilink plus the resolvable address, `[[<title>]] (<node id>)`. " +
          "The title is the node's graph name; the id half is the full node " +
          "token (the address of record — resolvable by read_body et al.). " +
          "Unknown node → structured { error: 'unknown_node' }.",
        inputSchema: {
          node_id: z
            .string()
            .describe("The note whose compound reference to mint."),
        },
      },
      async ({ node_id }) => {
        const result = await copyReference(dial, node_id);
        if (isCopyReferenceError(result)) {
          return {
            content: [
              { type: "text", text: `${result.error}: ${result.detail}` },
            ],
            structuredContent: structured(result),
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: result.compound }],
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
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
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
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
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

  if (options?.containers !== undefined) {
    const facet = options.containers;
    const containerOpField = z.discriminatedUnion("op", [
      z.object({
        op: z.literal("add"),
        text: z.string().describe("The new block's prose."),
        position: z
          .string()
          .min(1)
          .describe("Fractional order key (bytewise order; client-minted)."),
      }),
      z.object({
        op: z.literal("update"),
        slot: z.string().regex(/^[0-9a-f]{64}$/),
        oldBlobId: z.string().min(1),
        text: z.string(),
      }),
      z.object({
        op: z.literal("reorder"),
        slot: z.string().regex(/^[0-9a-f]{64}$/),
        oldPosition: z.string().min(1),
        position: z.string().min(1),
      }),
      z.object({
        op: z.literal("remove"),
        slot: z.string().regex(/^[0-9a-f]{64}$/),
        position: z.string().min(1),
        blobId: z.string().min(1),
      }),
    ]);
    server.registerTool(
      "write_container",
      {
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
        title: "Write a container (the tree-native save)",
        description:
          "041 F4 (Git for Ideas): save a container as ONE graph " +
          "transaction. Blob-first: prose mints into the content-deduped " +
          "blob store, then the surviving ops ride one admit batch of tree " +
          "facts (add births a slot; update repoints one; reorder rewrites " +
          "a position; remove retracts a slot's facts). Byte-identical " +
          "content nets out before the batch — a save that nets to nothing " +
          "writes nothing. Returns {noop, applied, minted, blobIds}; a " +
          "refused batch surfaces the gate's violations and leaves NO tree " +
          "change (minted blobs remain as orphans for the census).",
        inputSchema: {
          container: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .describe("The container node's 64-hex token."),
          ops: z.array(containerOpField).min(1).describe("The save's ops."),
          tenant: z
            .enum(["notes", "documents", "comments", "governance"])
            .optional()
            .describe("The tenant graph (default: notes)."),
        },
      },
      async ({ container, ops, tenant }) => {
        try {
          const result = await writeContainer(
            facet,
            container,
            ops,
            tenant ?? "notes",
          );
          return {
            content: [
              {
                type: "text",
                text: result.noop
                  ? "noop: every op netted out"
                  : `applied ${String(result.applied.length)} op(s)`,
              },
            ],
            structuredContent: structured(result),
          };
        } catch (err) {
          if (err instanceof ChaosClientError) {
            return {
              content: [{ type: "text", text: `${err.code}: ${err.message}` }],
              structuredContent: structured({
                error: err.code,
                violations: err.violations,
              }),
              isError: true,
            };
          }
          throw err;
        }
      },
    );
  }

  if (options?.containers !== undefined) {
    const facet = options.containers;
    server.registerTool(
      "read_container",
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
        title: "Read a container (ordered blocks, optionally as-of)",
        description:
          "042 F5 (Git for Ideas): resolve a container's tree and fetch its " +
          "prose in ONE batched blob lookup — blocks in position order. " +
          "as_of_tx reads the container as it stood at that transaction " +
          "(members since removed included). A tree fact naming an absent " +
          "blob surfaces as dangling (text null) — reported, never " +
          "fabricated.",
        inputSchema: {
          container: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .describe("The container node's 64-hex token."),
          as_of_tx: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Read the container as it stood at this transaction."),
        },
      },
      async ({ container, as_of_tx }) => {
        const result = await readContainer(
          facet,
          container,
          as_of_tx !== undefined ? { asOfTx: as_of_tx } : undefined,
        );
        return {
          content: [
            {
              type: "text",
              text: `${String(result.blocks.length)} block(s)${
                as_of_tx !== undefined ? ` as of tx ${String(as_of_tx)}` : ""
              }`,
            },
          ],
          structuredContent: structured(result),
        };
      },
    );

    server.registerTool(
      "container_history",
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
        title: "A container's history (the graph's transactions)",
        description:
          "042 F5 (Git for Ideas): every transaction that touched the " +
          "container or any slot it EVER held (the door's log closure over " +
          "tree_member — removed members' edits stay reachable), ascending, " +
          "with authors and timestamps. No revision table: history IS the " +
          "graph. Reconstruct any moment with read_container(as_of_tx).",
        inputSchema: {
          container: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .describe("The container node's 64-hex token."),
        },
      },
      async ({ container }) => {
        const transactions = await containerHistory(facet, container);
        return {
          content: [
            {
              type: "text",
              text: `${String(transactions.length)} transaction(s)`,
            },
          ],
          structuredContent: structured({
            transactions,
            count: transactions.length,
          }),
        };
      },
    );
  }

  return server;
}
