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
import { witnessToolCalls, withHeartbeat } from "@forge/stellar-core-ts";
import type { RequestLog } from "@forge/stellar-core-ts";
import { isAuthoredBy, validateWriteProvenance } from "../types.js";
import type { AuthoredBy, BodyClient } from "../types.js";
import type { RevisionStore } from "../revision-store.js";
import {
  applySectionOps,
  copyReference,
  isCopyReferenceError,
  look,
  unpin,
  readBody,
  readBodyAt,
  readBodyRevisions,
  writeBody,
} from "./tools.js";
import { dissolveContainer } from "../notes-sink.js";
import {
  DELETE_NOTE_MAX,
  deleteNotes,
  isDeleteNotesError,
} from "../note-delete.js";
import {
  frontmatterOf,
  isSetPropertiesError,
  setProperties,
  withFrontmatter,
} from "../properties.js";
import type { FocusRegister } from "../focus-register.js";
import {
  createNote,
  isCreateNoteError,
  listByTag,
  listTags,
  maybeReconcileInlineTags,
  NOTE_KIND,
} from "./tools.js";
import type { ChaosFacet } from "../chaos-client.js";
import { ChaosClientError } from "../chaos-client.js";
import { type ContainerFacet, writeContainer } from "../container-write.js";
import { isPatchError, patchContainer } from "../container-patch.js";
import type { AuthorKind, NotePublisher } from "./consciousness-emit.js";
import { projectNote } from "./note-projection.js";
import { containerHistory, readContainer } from "../container-read.js";
import { containerBodies } from "../container-body.js";
import { runBlobCensus } from "../blob-census.js";
import type { TagStore } from "../tag-store.js";
import type { SearchProvider, SearchResponse } from "../search-types.js";

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
  /** Serve the PATH-ADDRESSED body verbs (read_body/write_body/…): the
   *  DESKTOP's loopback surface, engine-backed since F14. The fleet never
   *  passes this — F12 retired the body families from the fleet surface
   *  (the container verbs are the one write path). */
  pathBodies?: boolean;
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
  /** Stream of Consciousness pass 4: the index-bus producer the write verbs
   *  publish through after a committed note write. Absent = no publish (and
   *  the boot says so). */
  consciousness?: NotePublisher;
  /** The witness: when present, every `tools/call` this server dispatches
   *  leaves one request record. Installed on the dispatcher before any tool
   *  registers, so a verb added later is covered by construction. */
  witness?: RequestLog | undefined;
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
  // BEFORE the first tool registers: McpServer installs its one `tools/call`
  // handler when the first tool lands, and the witness wraps that registration.
  if (options?.witness !== undefined)
    witnessToolCalls(server.server, options.witness);

  // Stream of Consciousness pass 4: publish the note AFTER its write landed.
  // Best-effort by construction — the publisher counts its own failures and
  // never throws; a projection that cannot be read is logged and the write
  // still stands. The index being behind is the publisher's metric to carry.
  const consciousness = options?.consciousness;
  const publishNote = async (
    facet: ContainerFacet,
    node: string,
    extras: { authorKind?: AuthorKind } = {},
  ): Promise<void> => {
    if (consciousness === undefined) return;
    try {
      const projection = await projectNote(facet, node, extras);
      if (projection !== undefined) await consciousness.publish(projection);
    } catch (err) {
      process.stderr.write(
        `calliope-consciousness: could not project note ${node.slice(0, 16)}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };

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

  // The same reconcile behind a container save. The removed body verbs ran
  // it after every write; write_container — aglaia's save since 081 F9 —
  // never did, so a `#tag` typed or deleted in the editor never reached
  // hasTag or the note_tags mirror. It reads the body back through the TREE
  // (containerBodies), never the body client, whose pg form dials the
  // dropped `sections` table. Notes tenant only: the other tenants' prose is
  // not a note's. Non-fatal for the same reason as above, but the outcome
  // rides the result so a caller can see the tag path ran.
  const tagChaos = options?.chaos;
  const inlineTags = options?.tags;
  const afterContainerWrite = async (
    facet: ContainerFacet,
    container: string,
  ): Promise<{
    tags?: { added: string[]; removed: string[] };
    tags_error?: string;
  }> => {
    if (tagChaos === undefined || inlineTags === undefined) {
      return {};
    }
    try {
      const delta = await maybeReconcileInlineTags(
        containerBodies(facet),
        tagChaos.dial,
        tagChaos.scope,
        inlineTags,
        container,
      );
      return delta === undefined ? {} : { tags: delta };
    } catch (err) {
      // String(), not .message: an Error keeps its class name, anything
      // else still renders.
      const detail = String(err);
      console.error(
        `calliope-mcp: inline-tag reconcile failed for ${container}: ${detail}`,
      );
      return { tags_error: detail };
    }
  };

  if (options?.pathBodies === true) {
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
  }

  // ── F3: the block-native verb surface — the primary grain ────────────────

  // ── 026: comments — the attributed-review surface ────────────────────────

  if (options?.pathBodies === true) {
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
  }

  if (options?.pathBodies === true) {
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
                    .describe(
                      "Optional new key (an edit+move in one gesture).",
                    ),
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
  }

  if (options?.pathBodies === true) {
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
  }

  if (options?.pathBodies === true) {
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
  }

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

  if (options?.pathBodies === true) {
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
    // calliope#5290: the note verbs read and write prose through the TREE
    // — the path read_container / write_container already serve — never
    // through the body client, whose pg form still dials the `sections`
    // table the cut dropped (every by-id materialize on the live star
    // erred `relation "sections" does not exist` while read_container on
    // the same id answered). The fleet always carries the container facet
    // (backend.ts wires it beside the chaos facet); the bare client is the
    // fixture-only harness shape.
    const bodies =
      options.containers !== undefined
        ? containerBodies(options.containers)
        : client;

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
          schema_type: z
            .string()
            .optional()
            .describe(
              "The note_type provenance (Plan, Note, …) — the attribute " +
                "typed queries key on (F10).",
            ),
          file_path: z
            .string()
            .optional()
            .describe("The source's absolute path provenance."),
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
        schema_type,
        file_path,
        mtime,
        ctime,
        raw_hash,
      }) => {
        const result = await dissolveContainer(
          bodies,
          dial,
          scope,
          options.tags,
          {
            source_path,
            blocks: blocks.map((b) => b.text),
            ...(title !== undefined ? { title } : {}),
            ...(source_kind !== undefined ? { source_kind } : {}),
            ...(schema_type !== undefined ? { schema_type } : {}),
            ...(file_path !== undefined ? { file_path } : {}),
            ...(mtime !== undefined ? { mtime } : {}),
            ...(ctime !== undefined ? { ctime } : {}),
            ...(raw_hash !== undefined ? { raw_hash } : {}),
          },
        );
        if (
          result.generation !== "nooped" &&
          options.containers !== undefined
        ) {
          // A dissolve is the human's own act of promotion.
          await publishNote(options.containers, result.node_id, {
            authorKind: "human",
          });
        }
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
        // A missing handle never reaches a read — the miss is decided
        // before the body is asked for, so the no-handle path performs no
        // dial read at all (pinned by the container-body suite).
        const miss = (detail: string) => ({
          content: [
            { type: "text" as const, text: `container_not_found: ${detail}` },
          ],
          structuredContent: structured({
            error: "container_not_found",
            detail,
          }),
          isError: true,
        });
        if (nodeId === undefined) {
          return miss(
            container_id ??
              source_path ??
              "export_note needs a container_id or a source_path",
          );
        }
        const body = await bodies.readBody(nodeId);
        if (body.length === 0) {
          return miss(nodeId);
        }
        // The source YAML (set_properties' `frontmatter` literal) re-joins
        // the export as its leading fence, so a vault note round-trips.
        const markdown = withFrontmatter(
          body.map((s) => s.text).join("\n\n"),
          frontmatterOf(await dial.edges(nodeId)),
        );
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
        const body = await bodies.readBody(nodeId);
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
        const fm = frontmatterOf(edges);
        const result = {
          container_id: nodeId,
          ...(fm !== null ? { frontmatter: fm } : {}),
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
          type: z
            .string()
            .regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
            .default(NOTE_KIND)
            .describe("The hasType edge; the node kind stays Note."),
        },
      },
      async ({ title, parent, tags, type }) => {
        const result = await createNote(
          dial,
          scope,
          {
            title,
            ...(parent !== undefined ? { parent } : {}),
            ...(tags !== undefined ? { tags } : {}),
            type,
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

    server.registerTool(
      "delete_note",
      {
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        },
        title: "Delete notes (retract every current fact)",
        description:
          "Take Note nodes off the notes graph: every current outbound and " +
          "inbound fact, each block slot's facts, and the tag-mirror rows. " +
          "History keeps the retracted facts; blobs are left to the census. " +
          "dry_run defaults to TRUE and reports what would go (edges by " +
          "predicate, blocks, blobs, tags). Takes up to " +
          `${String(DELETE_NOTE_MAX)} ids. Refuses the whole call, writing ` +
          "nothing, on a non-Note, a protected note (archived, or claimed " +
          "by another star) or a parent of a note outside the call. A " +
          "note already gone answers not_found.",
        inputSchema: {
          ids: z
            .array(z.string().regex(/^[0-9a-f]{64}$/))
            .min(1)
            .max(DELETE_NOTE_MAX)
            .describe("Note node tokens."),
          dry_run: z
            .boolean()
            .optional()
            .describe("Default true. false deletes."),
        },
      },
      async ({ ids, dry_run }) => {
        const result = await deleteNotes(dial, scope, options.tags, {
          ids,
          dry_run,
        });
        if (isDeleteNotesError(result)) {
          return {
            content: [
              { type: "text", text: `${result.error}: ${result.detail}` },
            ],
            structuredContent: structured(result),
            isError: true,
          };
        }
        const t = result.totals;
        return {
          content: [
            {
              type: "text",
              text:
                `${result.dry_run ? "would delete" : "deleted"} ` +
                `${String(t.deleted)} note(s), ${String(t.not_found)} not ` +
                `found, ${String(t.blocks)} block(s), ` +
                `${String(t.tag_rows)} tag row(s).`,
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

    const propertyValue = z.union([
      z.object({ literal: z.string() }).strict(),
      z.object({ node: z.string() }).strict(),
    ]);
    server.registerTool(
      "set_properties",
      {
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        },
        title: "Set a note's properties (frontmatter as edges)",
        description:
          "Land a note's frontmatter on the graph: each named predicate's " +
          "values become exactly the given set (literals, or node tokens for " +
          "resolved wikilinks); unnamed predicates are untouched. tags[] " +
          "ride the C9 explicit tag path; frontmatter is the source YAML, " +
          "kept verbatim as one literal so export_note can reproduce it. " +
          "retract:true removes exactly the named values (the revert form). " +
          "Idempotent — a re-run is a read. Returns {node_id, added, " +
          "removed, tags_added, tags_removed, tags_skipped, tx?}; misses are " +
          "structured (not_a_note / bad_predicate / bad_value / bad_target / " +
          "admit_refused).",
        inputSchema: {
          container_id: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .describe("The note's node token."),
          properties: z
            .array(
              z.object({
                predicate: z.string().min(1),
                values: z.array(propertyValue),
              }),
            )
            .optional()
            .describe("predicate → values; a node value is a 64-hex token."),
          tags: z.array(z.string()).optional().describe("Explicit tags."),
          frontmatter: z
            .string()
            .optional()
            .describe("The source YAML (between the fences), verbatim."),
          retract: z
            .boolean()
            .optional()
            .describe("Remove exactly the named values instead of setting."),
        },
      },
      async (args) => {
        const result = await setProperties(dial, scope, tagStore, args);
        if (isSetPropertiesError(result)) {
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
              text:
                `+${String(result.added.length)} -${String(result.removed.length)} edge(s), ` +
                `+${String(result.tags_added.length)} -${String(result.tags_removed.length)} tag(s).`,
            },
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
        title: "Write a container (one graph transaction)",
        description:
          "Save a container as ONE graph transaction. Send EITHER ops " +
          "(add/update/reorder/remove; identical content nets out) OR " +
          "replacements (literal, case-sensitive find/replace applied " +
          "server-side in order, optionally to one slot; any expected_count " +
          "miss refuses the whole batch as count_mismatch, nothing written). " +
          "Returns noop, the tx and, for replacements, the counts.",
        inputSchema: {
          container: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .describe("The container node's 64-hex token."),
          ops: z.array(containerOpField).min(1).optional(),
          slot: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional()
            .describe("With replacements: patch this block only."),
          replacements: z
            .array(
              z.object({
                find: z.string().min(1),
                replace: z.string(),
                expected_count: z.number().int().min(0),
              }),
            )
            .min(1)
            .optional(),
          tenant: z
            .enum(["notes", "documents", "comments", "governance", "issues"])
            .optional()
            .describe("Default: notes."),
        },
      },
      async ({ container, ops, slot, replacements, tenant }) => {
        const graph = tenant ?? "notes";
        const refuse = (error: string, detail: string) => ({
          content: [{ type: "text" as const, text: `${error}: ${detail}` }],
          structuredContent: structured({ error, detail }),
          isError: true,
        });
        const exactlyOne = "send exactly one of ops or replacements";
        try {
          let result: Record<string, unknown> & { noop: boolean };
          let text: string;
          if (replacements !== undefined) {
            if (ops !== undefined) return refuse("bad_arguments", exactlyOne);
            const patched = await patchContainer(
              facet,
              { container, slot, replacements },
              graph,
            );
            if (isPatchError(patched)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `${patched.error}: ${patched.detail}`,
                  },
                ],
                structuredContent: structured(patched),
                isError: true,
              };
            }
            result = { ...patched };
            text = patched.noop
              ? "noop: the replacements changed nothing"
              : `patched ${String(patched.slots_changed.length)} block(s) in tx ${String(patched.tx)}`;
          } else if (ops !== undefined) {
            if (slot !== undefined) {
              return refuse(
                "bad_arguments",
                "slot applies only to replacements",
              );
            }
            const saved = await writeContainer(facet, container, ops, graph);
            result = { ...saved };
            text = saved.noop
              ? "noop: every op netted out"
              : `applied ${String(saved.applied.length)} op(s)`;
          } else {
            return refuse("bad_arguments", exactlyOne);
          }
          let tagOutcome = {};
          if (!result.noop && graph === "notes") {
            // Tags before the publish, so the projection carries them.
            tagOutcome = await afterContainerWrite(facet, container);
            await publishNote(facet, container);
          }
          return {
            content: [{ type: "text", text }],
            structuredContent: structured({ ...result, ...tagOutcome }),
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

  if (options?.containers?.gc !== undefined) {
    const gc = options.containers.gc;
    const dial = options.containers.dial;
    server.registerTool(
      "blob_census",
      {
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
        },
        title: "The blob census (mark-and-sweep GC)",
        description:
          "F7 (Git for Ideas): the reachability census with the roles " +
          "swapped — the blob store asks, each tenant graph reports the " +
          "blob ids its LOG holds. A census with ANY reporter missing is " +
          "incomplete and reaps nothing. Mark-and-sweep: a complete census " +
          "marks the unheld; execute=true reaps only ids a PREVIOUS " +
          "complete census already marked and that are still unheld (the " +
          "grace window for saves in flight). Facts naming absent blobs " +
          "are reported dangling, never fixed. Held is the log, so only " +
          "never-referenced orphans ever reap.",
        inputSchema: {
          execute: z
            .boolean()
            .optional()
            .describe("Reap previously-marked, still-unheld blobs."),
        },
      },
      // `extra` carries the caller's progress token; the census is the one
      // verb here that can outlive hades' 25s IDLE reap, because it is a
      // mark-and-sweep in which every tenant graph reports the blob ids its
      // log holds — unbounded by construction and growing with the store.
      // Without a beat the router stops waiting, the sweep keeps running
      // star-side, and the caller is told to consider retrying a GC pass
      // that may already be reaping.
      async ({ execute }, extra) => {
        const report = await withHeartbeat(extra, "blob census", () =>
          runBlobCensus(
            { gc, dial },
            execute === true ? { execute: true } : {},
          ),
        );
        return {
          content: [
            {
              type: "text",
              text: report.complete
                ? `complete: ${String(report.held)} held, ${String(report.marked.length)} marked, ${String(report.reaped.length)} reaped, ${String(report.dangling.length)} dangling`
                : "INCOMPLETE census — nothing marked, nothing reaped",
            },
          ],
          structuredContent: structured(report),
        };
      },
    );
  }

  return server;
}
