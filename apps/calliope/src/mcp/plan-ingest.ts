/**
 * `read_plan` — the C7 plan-ingest surface (athena by-reference projection).
 *
 * A projection-shaped read over the document store: it resolves a plan document
 * *by reference* (a handle — a document id or source_path) and serves either the
 * whole plan's block index (+ body) or a single feature block by its address.
 * This is the read athena's `orchestrate_plan` calls to take a plan by reference
 * instead of loading the whole `plan_text` into the projecting session's
 * context, and the read the projecter's conflict payload calls to return a
 * single colliding feature as a Calliope **block ref**.
 *
 * It builds on the live `read_documents` store contract — a plan is just a
 * `documents` row whose `body_text` is markdown — and the pure block-addressing
 * scheme in {@link ../plan-blocks}. A pure function of a {@link DocumentStore}
 * (no wire), so it is unit-tested over {@link FixtureDocumentStore} exactly the
 * way the MCP layer drives it in production.
 *
 * ## The athena → Calliope contract
 *
 * - **By reference.** athena carries a `PlanHandle` — `{ document }` (the doc id)
 *   or `{ source_path }` (newest version wins) — never the bytes. Calliope
 *   resolves it and moves the prose server-side.
 * - **Whole-plan read** (`read_plan(handle)`): returns `{ handle, title,
 *   block_count, blocks: [{ id, title, size, order }], body_text? }` — the block
 *   *index* (the addresses athena projects over) plus, unless `omit_body` is set,
 *   the full plan body. The block index is the by-reference substitute for
 *   re-transcribing the plan into the LLM's context.
 * - **Single-block read** (`read_plan(handle, { block })`): returns `{ handle,
 *   block: { id, title, size, order, text } }` — just that feature's markdown.
 *   `handle.block` echoes the canonical address so the caller holds a durable
 *   block ref.
 * - **Misses** are structured, never thrown: `document_not_found` (no such
 *   plan), `block_not_found` (the plan has no such feature block).
 */

import type { DocumentRow, DocumentStore } from "../document-store.js";
import {
  parsePlanBlocks,
  sliceBlock,
  toBlockRef,
  type PlanBlock,
  type PlanBlockRef,
} from "../plan-blocks.js";

/** A by-reference handle to a plan document (one of `document` / `source_path`). */
export interface PlanHandle {
  /** The document id (the primary, stable reference). */
  document?: number;
  /** The plan's source path — resolves to the newest stored version. */
  source_path?: string;
}

/** `read_plan` arguments — a handle plus the optional block address + flags. */
export interface ReadPlanArgs extends PlanHandle {
  /** A feature-id block address (`C7`); when set, serve just that block. */
  block?: string;
  /** Whole-plan reads only: omit the full `body_text` (index-only). */
  omit_body?: boolean;
}

/** The echoed handle on a result (resolved id + source_path, + block when scoped). */
export interface ResolvedHandle {
  document: number;
  source_path: string;
  block?: string;
}

/** Whole-plan result: the block index (+ body unless omitted). */
export interface ReadPlanWholeResult {
  handle: ResolvedHandle;
  title: string | null;
  block_count: number;
  blocks: PlanBlockRef[];
  body_text?: string;
}

/** Single-block result: the addressed feature block's prose. */
export interface ReadPlanBlockResult {
  handle: ResolvedHandle;
  block: PlanBlock;
}

/** A structured miss (never thrown across the verb boundary). */
export interface ReadPlanError {
  error: "document_not_found" | "block_not_found" | "bad_handle";
  detail: string;
}

export type ReadPlanResult =
  ReadPlanWholeResult | ReadPlanBlockResult | ReadPlanError;

/** Resolve the handle to a single stored document row, or `null` for a miss. */
async function resolveDocument(
  store: DocumentStore,
  args: PlanHandle,
): Promise<DocumentRow | null> {
  if (args.document !== undefined) {
    return store.byId(args.document);
  }
  if (args.source_path !== undefined) {
    const rows = await store.bySourcePath(args.source_path);
    // bySourcePath returns newest-first; the newest version is the plan.
    return rows[0] ?? null;
  }
  return null;
}

/**
 * `read_plan` — resolve a plan by reference and serve its blocks.
 * See the module doc for the athena → Calliope contract.
 */
export async function readPlan(
  store: DocumentStore,
  args: ReadPlanArgs,
): Promise<ReadPlanResult> {
  if (args.document === undefined && args.source_path === undefined) {
    return {
      error: "bad_handle",
      detail: "read_plan needs a `document` id or a `source_path`.",
    };
  }

  const row = await resolveDocument(store, args);
  if (row === null) {
    return {
      error: "document_not_found",
      detail:
        args.document !== undefined
          ? `document #${String(args.document)}`
          : `source_path ${String(args.source_path)}`,
    };
  }

  const resolved: ResolvedHandle = {
    document: row.id,
    source_path: row.source_path,
  };

  // Single-block read: address one feature block by id.
  if (args.block !== undefined) {
    const block = sliceBlock(row.body_text, args.block);
    if (block === null) {
      return {
        error: "block_not_found",
        detail: `plan #${String(row.id)} has no feature block ${args.block}`,
      };
    }
    return { handle: { ...resolved, block: block.id }, block };
  }

  // Whole-plan read: the block index (+ body unless omitted).
  const blocks = parsePlanBlocks(row.body_text);
  const result: ReadPlanWholeResult = {
    handle: resolved,
    title: row.title,
    block_count: blocks.length,
    blocks: blocks.map(toBlockRef),
  };
  if (args.omit_body !== true) {
    result.body_text = row.body_text;
  }
  return result;
}

/** Type guard: did `read_plan` return a structured miss? */
export function isReadPlanError(r: ReadPlanResult): r is ReadPlanError {
  return "error" in r;
}
