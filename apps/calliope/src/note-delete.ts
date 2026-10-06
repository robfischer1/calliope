/**
 * delete_note — take a Note off the notes graph, so a bulk import can be
 * reversed. `dissolve_note` only adds a generation and `write_container`
 * can only empty a body; neither removes the note.
 *
 * THE STORE'S RETRACTION MODEL. chaos is an append-only datom log; a
 * deletion is the retraction of every CURRENT fact, and the log keeps
 * the retracted datoms (`read_container(as_of_tx)` and `container_history`
 * still reconstruct the note). The gate calliope writes through (themis
 * `admit`) carries `removeEdge` and no `deleteNode`, so this is the same
 * shape athena's `task_delete` uses: read every current fact, retract
 * each one pinned to the scope it lives in, in one admit batch per note.
 * The dictionary row is not tombstoned, which only chaos `deleteNode`
 * can do.
 *
 * What goes, per note:
 *  - every outbound fact (name, type, parent, tags, provenance,
 *    frontmatter predicates, tree_member, supersededBy, anything else);
 *  - every inbound node fact (another note's property edge onto it, a
 *    supersession pointing at it, a hasMember, …);
 *  - each block slot's own facts (tree_position, tree_content) and any
 *    other edge onto the slot, unless ANOTHER container also holds the
 *    slot, in which case only this note's membership goes;
 *  - the note's tag-mirror rows, so `list_tags` stops counting it.
 *
 * What stays:
 *  - system edges (`ownedBy`, `hasKind`). chaos writes those itself, and
 *    the migration unwind measured that retracting ownedBy loops forever
 *    (7d3425a);
 *  - blobs. Blob lifetime belongs to the census (`blob_census`), and the
 *    census counts a blob as held while the LOG names it, so a deleted
 *    note's blobs and any blob another note shares are never reaped by
 *    this verb or because of it.
 *
 * Refusals are decided for the whole call before anything is written:
 * an id that is not a Note, a protected note (the frozen phdb archive,
 * `isArchived=true`, or a note another star has claimed via ownedBy), or
 * a note with a child outside the call refuses the call. An id with no
 * current semantic facts is `not_found`, which is how a re-delete answers.
 */

import {
  type ChaosDial,
  type ChaosOp,
  type EdgeTarget,
  opRemove,
  type PlacedEdge,
} from "./chaos-client.js";
import type { TagStore } from "./tag-store.js";
import { TREE_CONTENT, TREE_MEMBER } from "./tree.js";

/** The largest batch one call takes. */
export const DELETE_NOTE_MAX = 100;

/** Edges chaos writes itself; never retracted, never evidence of a note. */
export const SYSTEM_PREDICATES: ReadonlySet<string> = new Set([
  "ownedBy",
  "hasKind",
]);

/** Owner anchors whose notes this verb may delete: calliope's own mints
 *  carry no owner claim (chaos derives `unclaimed`). Any other owner is a
 *  star that claimed the note, and the note is that star's to delete. */
export const DELETABLE_OWNERS: ReadonlySet<string> = new Set([
  "unclaimed",
  "calliope",
]);

const NOTE_TYPE = "Note";
const TOKEN_RE = /^[0-9a-f]{64}$/;

export interface DeleteNotesInput {
  ids: string[];
  /** Default true: report what would go and write nothing. */
  dry_run?: boolean | undefined;
}

/** One note's plan, and after a real run its outcome. */
export interface NoteDeletion {
  node_id: string;
  status: "would_delete" | "deleted" | "not_found";
  /** Outbound facts retracted, by predicate. */
  edges_out: Record<string, number>;
  /** Inbound facts retracted, by predicate. */
  edges_in: Record<string, number>;
  /** Block slots whose facts are retracted. */
  blocks: number;
  /** Slots another container also holds: only the membership goes. */
  shared_blocks: number;
  /** Blob ids the note's blocks referenced. None is deleted. */
  blobs: string[];
  /** Tag-mirror rows removed. */
  tags: string[];
  /** The graph transaction the retraction landed as (real runs). */
  tx?: number;
}

export interface DeleteRefusal {
  node_id: string;
  error: "not_a_note" | "protected" | "has_children";
  detail: string;
}

export interface DeleteNotesResult {
  dry_run: boolean;
  notes: NoteDeletion[];
  totals: {
    deleted: number;
    not_found: number;
    edges_out: Record<string, number>;
    edges_in: Record<string, number>;
    blocks: number;
    shared_blocks: number;
    blobs_referenced: number;
    blobs_deleted: 0;
    tag_rows: number;
  };
}

export interface DeleteNotesError {
  error: "bad_arguments" | "unsupported" | "refused" | "admit_refused";
  detail: string;
  refused?: DeleteRefusal[];
  violations?: unknown[];
  /** On admit_refused: the notes that landed before the refusal. */
  notes?: NoteDeletion[];
}

export function isDeleteNotesError(
  r: DeleteNotesResult | DeleteNotesError,
): r is DeleteNotesError {
  return "error" in r;
}

interface Plan {
  deletion: NoteDeletion;
  ops: ChaosOp[];
  /** Removes the note's tag-mirror rows; absent without a tag store. */
  untag?: () => Promise<unknown>;
}

type Dial = ChaosDial & Required<Pick<ChaosDial, "placedEdges" | "referrers">>;

function bump(counts: Record<string, number>, predicate: string): void {
  counts[predicate] = (counts[predicate] ?? 0) + 1;
}

function targetOf(e: PlacedEdge): EdgeTarget {
  if (e.domain === "blob") return { toBlob: e.value };
  return e.isNode ? { toNode: e.value } : { toLiteral: e.value };
}

const semantic = (edges: PlacedEdge[]): PlacedEdge[] =>
  edges.filter((e) => !SYSTEM_PREDICATES.has(e.predicate));

/** Why `out` (a node's semantic outbound facts) may not be deleted. */
async function guard(
  dial: Dial,
  id: string,
  out: PlacedEdge[],
  all: PlacedEdge[],
): Promise<DeleteRefusal | null> {
  if (
    !out.some(
      (e) => e.predicate === "hasType" && !e.isNode && e.value === NOTE_TYPE,
    )
  ) {
    return {
      node_id: id,
      error: "not_a_note",
      detail: `${id} carries no hasType=${NOTE_TYPE} edge`,
    };
  }
  if (
    out.some(
      (e) => e.predicate === "isArchived" && !e.isNode && e.value === "true",
    )
  ) {
    return {
      node_id: id,
      error: "protected",
      detail: `${id} is in the frozen archive (isArchived=true)`,
    };
  }
  const owners = all
    .filter((e) => e.predicate === "ownedBy" && e.isNode)
    .map((e) => e.value);
  if (owners.length > 0) {
    const labels = await dial.resolveNodes(owners);
    for (const owner of owners) {
      const label = labels[owner]?.trim().toLowerCase();
      if (label !== undefined && !DELETABLE_OWNERS.has(label)) {
        return {
          node_id: id,
          error: "protected",
          detail: `${id} is owned by ${label}, not calliope`,
        };
      }
    }
  }
  return null;
}

/** Read one note and compose its retraction. A refusal or not_found
 *  composes nothing. */
async function plan(
  dial: Dial,
  id: string,
  batch: ReadonlySet<string>,
): Promise<Plan | DeleteRefusal> {
  const deletion: NoteDeletion = {
    node_id: id,
    status: "would_delete",
    edges_out: {},
    edges_in: {},
    blocks: 0,
    shared_blocks: 0,
    blobs: [],
    tags: [],
  };
  const all = await dial.placedEdges(id);
  const out = semantic(all);
  if (out.length === 0) {
    deletion.status = "not_found";
    return { deletion, ops: [] };
  }
  const refusal = await guard(dial, id, out, all);
  if (refusal !== null) return refusal;

  const inbound = semantic(await dial.referrers(id));
  const strays = inbound.filter(
    (e) => e.predicate === "parent" && !batch.has(e.subject),
  );
  if (strays.length > 0) {
    return {
      node_id: id,
      error: "has_children",
      detail:
        `${id} is the parent of ${String(strays.length)} note(s) outside ` +
        `this call (${strays.map((e) => e.subject).join(", ")})`,
    };
  }

  const retract: PlacedEdge[] = [];
  for (const e of out) {
    retract.push(e);
    bump(deletion.edges_out, e.predicate);
  }
  for (const e of inbound) {
    retract.push(e);
    bump(deletion.edges_in, e.predicate);
  }

  const blobs = new Set<string>();
  const slots = out
    .filter((e) => e.predicate === TREE_MEMBER && e.isNode)
    .map((e) => e.value);
  for (const slot of slots) {
    const holders = semantic(await dial.referrers(slot));
    const shared = holders.some(
      (e) => e.predicate === TREE_MEMBER && e.subject !== id,
    );
    if (shared) {
      deletion.shared_blocks += 1;
      continue;
    }
    deletion.blocks += 1;
    for (const e of semantic(await dial.placedEdges(slot))) {
      retract.push(e);
      if (e.predicate === TREE_CONTENT && e.domain === "blob") {
        blobs.add(e.value);
      }
    }
    for (const e of holders) retract.push(e);
  }
  deletion.blobs = [...blobs].sort((a, b) => Number(a) - Number(b));

  // A fact reached twice (the note's own membership, read from both ends)
  // is retracted once.
  const ops = new Map<string, ChaosOp>();
  for (const e of retract) {
    const op = opRemove(
      e.subject,
      e.predicate,
      targetOf(e),
      e.graph || undefined,
    );
    ops.set(JSON.stringify(op), op);
  }
  return { deletion, ops: [...ops.values()] };
}

function validate(ids: string[]): DeleteNotesError | null {
  if (ids.length === 0) {
    return { error: "bad_arguments", detail: "ids is empty" };
  }
  if (ids.length > DELETE_NOTE_MAX) {
    return {
      error: "bad_arguments",
      detail: `${String(ids.length)} ids; one call takes at most ${String(DELETE_NOTE_MAX)}`,
    };
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (!TOKEN_RE.test(id)) {
      return {
        error: "bad_arguments",
        detail: `${id} is not a 64-hex node token`,
      };
    }
    if (seen.has(id)) {
      return { error: "bad_arguments", detail: `${id} is repeated` };
    }
    seen.add(id);
  }
  return null;
}

function totalsOf(notes: NoteDeletion[]): DeleteNotesResult["totals"] {
  const totals: DeleteNotesResult["totals"] = {
    deleted: 0,
    not_found: 0,
    edges_out: {},
    edges_in: {},
    blocks: 0,
    shared_blocks: 0,
    blobs_referenced: 0,
    blobs_deleted: 0,
    tag_rows: 0,
  };
  const blobs = new Set<string>();
  for (const n of notes) {
    if (n.status === "not_found") totals.not_found += 1;
    else totals.deleted += 1;
    for (const [p, c] of Object.entries(n.edges_out)) {
      totals.edges_out[p] = (totals.edges_out[p] ?? 0) + c;
    }
    for (const [p, c] of Object.entries(n.edges_in)) {
      totals.edges_in[p] = (totals.edges_in[p] ?? 0) + c;
    }
    totals.blocks += n.blocks;
    totals.shared_blocks += n.shared_blocks;
    totals.tag_rows += n.tags.length;
    for (const b of n.blobs) blobs.add(b);
  }
  totals.blobs_referenced = blobs.size;
  return totals;
}

/** The verb body. */
export async function deleteNotes(
  dial: ChaosDial,
  scope: string,
  tagStore: TagStore | undefined,
  input: DeleteNotesInput,
): Promise<DeleteNotesResult | DeleteNotesError> {
  const invalid = validate(input.ids);
  if (invalid !== null) return invalid;
  if (dial.placedEdges === undefined || dial.referrers === undefined) {
    return {
      error: "unsupported",
      detail: "this backend's dial cannot read placed edges",
    };
  }
  const placed = dial as Dial;
  const dryRun = input.dry_run !== false;
  const batch = new Set(input.ids);

  const plans: Plan[] = [];
  const refused: DeleteRefusal[] = [];
  for (const id of input.ids) {
    const p = await plan(placed, id, batch);
    if ("error" in p) refused.push(p);
    else plans.push(p);
  }
  if (refused.length > 0) {
    return {
      error: "refused",
      detail: `${String(refused.length)} of ${String(input.ids.length)} id(s) refused; nothing was written`,
      refused,
    };
  }
  if (tagStore !== undefined) {
    for (const p of plans) {
      if (p.deletion.status === "not_found") continue;
      const id = p.deletion.node_id;
      const tags = (await tagStore.byNode(id)).map((r) => r.tag);
      p.deletion.tags = tags;
      p.untag = () => Promise.all(tags.map((t) => tagStore.remove(id, t)));
    }
  }
  if (dryRun) {
    const notes = plans.map((p) => p.deletion);
    return { dry_run: true, notes, totals: totalsOf(notes) };
  }

  // One admit per note: a refusal mid-call leaves every earlier note fully
  // gone and every later one untouched, never a half-deleted note. A fact
  // two notes share (a parent edge inside the call) is retracted once.
  const done = new Set<string>();
  const landed: NoteDeletion[] = [];
  for (const p of plans) {
    const deletion = p.deletion;
    const ops = p.ops.filter((op) => !done.has(JSON.stringify(op)));
    if (ops.length > 0) {
      const res = await dial.admit(ops, scope);
      if (!res.admitted) {
        return {
          error: "admit_refused",
          detail: `the gate refused the retraction of ${deletion.node_id}`,
          violations: res.violations,
          notes: landed,
        };
      }
      if (res.tx !== undefined) deletion.tx = res.tx;
    }
    for (const op of p.ops) done.add(JSON.stringify(op));
    await p.untag?.();
    if (deletion.status !== "not_found") deletion.status = "deleted";
    landed.push(deletion);
  }
  return { dry_run: false, notes: landed, totals: totalsOf(landed) };
}
