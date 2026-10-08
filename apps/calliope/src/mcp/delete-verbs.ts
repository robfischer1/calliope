/**
 * The delete verbs: `delete_note` (suppress by default, `purge=true` to
 * retract) and `restore_note` (clear a suppression). Registered with the
 * chaos facet, beside the other note verbs.
 *
 * Rob's ruling (2026-10-06): a delete from the UI hides; nothing purges
 * unless asked, and nothing ever erases the log. So `purge` defaults to
 * false here and no caller sets it for him.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChaosDial } from "../chaos-client.js";
import {
  DELETE_NOTE_MAX,
  deleteNotes,
  isDeleteNotesError,
} from "../note-delete.js";
import { restoreNotes, suppressNotes } from "../note-suppress.js";
import type { TagStore } from "../tag-store.js";
import { outputSchemaOf } from "./output-schemas.js";

const ids = z
  .array(z.string().regex(/^[0-9a-f]{64}$/))
  .min(1)
  .max(DELETE_NOTE_MAX)
  .describe("Note node tokens.");

interface Answer {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

function answer(text: string, result: object, isError = false): Answer {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ...result },
    ...(isError ? { isError: true } : {}),
  };
}

/** How the delete verbs keep the search index (eros, over the
 *  `consciousness` stream) in step with the graph. Both never throw. */
export interface IndexSync {
  /** Tombstone the note's row: it leaves the index. */
  retract(node: string): Promise<void>;
  /** Re-publish the note from the graph: its row comes back. */
  publish(node: string): Promise<void>;
}

/** Register delete_note + restore_note on `server`. After a real (not dry)
 *  run, every id the call leaves hidden or gone (suppressed, already
 *  suppressed, purged, or with no facts at all) is retracted from the index,
 *  and every note restore brought back is published again — the graph write
 *  first, the index after it. Retracting the already-gone ids too is what
 *  heals a row a delete made before this sync existed left behind: a
 *  tombstone for a row the index never held reaps nothing. */
export function registerDeleteVerbs(
  server: McpServer,
  dial: ChaosDial,
  scope: string,
  tags: TagStore | undefined,
  index: IndexSync,
): void {
  const each = async (
    nodes: { node_id: string; status: string }[],
    statuses: readonly string[],
    act: (node: string) => Promise<void>,
  ): Promise<void> => {
    for (const n of nodes) {
      if (statuses.includes(n.status)) await act(n.node_id);
    }
  };
  server.registerTool(
    "delete_note",
    {
      outputSchema: outputSchemaOf("delete_note"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      title: "Delete notes (suppress; purge on request)",
      description:
        "Take Note nodes off every listing. By default (purge=false) a " +
        "note is SUPPRESSED: it keeps every fact and gains the literal " +
        "suppressed=true, which hides it from list_by_tag, list_tags, " +
        "search and look; read_container by its own id still answers, and " +
        "restore_note undoes it. A note already suppressed answers " +
        "already_suppressed. purge=true instead retracts every current " +
        "outbound and inbound fact, each block slot's facts, and the " +
        "tag-mirror rows; history keeps the retracted facts and blobs are " +
        "left to the census. dry_run defaults to TRUE and reports what " +
        "would change. Takes up to " +
        `${String(DELETE_NOTE_MAX)} ids. In both modes the whole call ` +
        "refuses, writing nothing, on a non-Note, a protected note " +
        "(archived, or claimed by another star) or a parent of a note " +
        "outside the call. A note with no current facts answers not_found.",
      inputSchema: {
        ids,
        dry_run: z.boolean().optional().describe("Default true. false writes."),
        purge: z
          .boolean()
          .optional()
          .describe(
            "Default false (suppress). true retracts every fact; restore " +
              "cannot undo it.",
          ),
      },
    },
    async ({ ids, dry_run, purge }) => {
      if (purge !== true) {
        const result = await suppressNotes(dial, scope, { ids, dry_run });
        if (isDeleteNotesError(result)) {
          return answer(`${result.error}: ${result.detail}`, result, true);
        }
        if (!result.dry_run) {
          await each(
            result.notes,
            ["suppressed", "already_suppressed", "not_found"],
            (n) => index.retract(n),
          );
        }
        const t = result.totals;
        return answer(
          `${result.dry_run ? "would suppress" : "suppressed"} ` +
            `${String(t.suppressed)} note(s), ` +
            `${String(t.already_suppressed)} already suppressed, ` +
            `${String(t.not_found)} not found.`,
          result,
        );
      }
      const result = await deleteNotes(dial, scope, tags, { ids, dry_run });
      if (isDeleteNotesError(result)) {
        return answer(`${result.error}: ${result.detail}`, result, true);
      }
      if (!result.dry_run) {
        await each(result.notes, ["deleted", "not_found"], (n) =>
          index.retract(n),
        );
      }
      const t = result.totals;
      return answer(
        `${result.dry_run ? "would purge" : "purged"} ` +
          `${String(t.deleted)} note(s), ${String(t.not_found)} not ` +
          `found, ${String(t.blocks)} block(s), ` +
          `${String(t.tag_rows)} tag row(s).`,
        { mode: "purge", ...result },
      );
    },
  );

  server.registerTool(
    "restore_note",
    {
      outputSchema: outputSchemaOf("restore_note"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Restore suppressed notes",
      description:
        "Undo delete_note's default suppress: retract each note's " +
        "suppressed=true marker and nothing else, so the note returns to " +
        "every listing with its edges as they were. A note that was never " +
        "suppressed answers not_suppressed. A PURGED note cannot be " +
        "restored here (its facts were retracted; history keeps them, " +
        "read_container(as_of_tx) still reads it) and answers not_found. " +
        `Takes up to ${String(DELETE_NOTE_MAX)} ids; a non-Note or a ` +
        "protected note refuses the call, writing nothing.",
      inputSchema: { ids },
    },
    async ({ ids }) => {
      const result = await restoreNotes(dial, scope, { ids });
      if (isDeleteNotesError(result)) {
        return answer(`${result.error}: ${result.detail}`, result, true);
      }
      await each(result.notes, ["restored"], (n) => index.publish(n));
      const t = result.totals;
      return answer(
        `restored ${String(t.restored)} note(s), ` +
          `${String(t.not_suppressed)} not suppressed, ` +
          `${String(t.not_found)} not found.`,
        result,
      );
    },
  );
}
