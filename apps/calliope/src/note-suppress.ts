import {
  type ChaosDial,
  type ChaosOp,
  graphToken,
  opAdd,
  opRemove,
} from "./chaos-client.js";
import {
  checkNote,
  type DeleteNotesError,
  type DeleteRefusal,
  type Dial,
  guard,
  NOTE_TYPES,
  SYSTEM_PREDICATES,
  validate,
} from "./note-delete.js";

/** The marker's predicate — the graph's existing "hidden, kept" literal. */
export const SUPPRESSED = "suppressed";
/** The marker's value. */
export const SUPPRESSED_VALUE = "true";

/** The notes the marker hides on `scope`: one indexed point lookup. */
export async function suppressedNotes(
  dial: Pick<ChaosDial, "findByValue">,
  scope: string,
): Promise<Set<string>> {
  return new Set(await dial.findByValue(scope, SUPPRESSED, SUPPRESSED_VALUE));
}

export interface NoteSuppression {
  node_id: string;
  status: "would_suppress" | "suppressed" | "already_suppressed" | "not_found";
}

export interface SuppressNotesResult {
  mode: "suppress";
  dry_run: boolean;
  notes: NoteSuppression[];
  totals: {
    suppressed: number;
    already_suppressed: number;
    not_found: number;
  };
  /** The graph transaction the markers landed as (real runs that wrote). */
  tx?: number;
}

function needsPlacedReads(dial: ChaosDial): dial is Dial {
  return dial.placedEdges !== undefined && dial.referrers !== undefined;
}

const UNSUPPORTED: DeleteNotesError = {
  code: "unsupported",
  detail: "this backend's dial cannot read placed edges",
};

/**
 * Suppress up to DELETE_NOTE_MAX notes. The protection rule is purge's,
 * decided for the whole call before anything is written. Every new marker
 * lands in ONE admit, so a call hides all its notes or none. A note that
 * already carries the marker is a no-op (`already_suppressed`). `types`
 * is what counts as a note: a Note, unless the verb widened it for its
 * caller (nomos may hide a Governance note; see `delete-verbs.ts`).
 */
export async function suppressNotes(
  dial: ChaosDial,
  scope: string,
  input: { ids: string[]; dry_run?: boolean | undefined },
  types: ReadonlySet<string> = NOTE_TYPES,
): Promise<SuppressNotesResult | DeleteNotesError> {
  const invalid = validate(input.ids);
  if (invalid !== null) return invalid;
  if (!needsPlacedReads(dial)) return UNSUPPORTED;
  const dryRun = input.dry_run !== false;
  const batch = new Set(input.ids);

  const hidden = await suppressedNotes(dial, scope);
  const notes: NoteSuppression[] = [];
  const refused: DeleteRefusal[] = [];
  for (const id of input.ids) {
    const checked = await checkNote(dial, id, batch, types);
    if (checked === null) {
      notes.push({ node_id: id, status: "not_found" });
    } else if ("code" in checked) {
      refused.push(checked);
    } else {
      notes.push({
        node_id: id,
        status: hidden.has(id) ? "already_suppressed" : "would_suppress",
      });
    }
  }
  if (refused.length > 0) {
    return {
      code: "batch_refused",
      detail: `${String(refused.length)} of ${String(input.ids.length)} id(s) refused; nothing was written`,
      refused,
    };
  }

  const pending = notes.filter((n) => n.status === "would_suppress");
  let tx: number | undefined;
  if (!dryRun && pending.length > 0) {
    const res = await dial.admit(
      pending.map((n) =>
        opAdd(n.node_id, SUPPRESSED, { toLiteral: SUPPRESSED_VALUE }),
      ),
      scope,
    );
    if (!res.admitted) {
      return {
        code: "admit_refused",
        detail: "the gate refused the suppression; nothing was written",
        violations: res.violations,
      };
    }
    tx = res.tx;
    for (const n of pending) n.status = "suppressed";
  }
  const count = (s: NoteSuppression["status"]) =>
    notes.filter((n) => n.status === s).length;
  return {
    mode: "suppress",
    dry_run: dryRun,
    notes,
    totals: {
      suppressed: dryRun ? count("would_suppress") : count("suppressed"),
      already_suppressed: count("already_suppressed"),
      not_found: count("not_found"),
    },
    ...(tx !== undefined ? { tx } : {}),
  };
}

export interface NoteRestore {
  node_id: string;
  status: "restored" | "not_suppressed" | "not_found";
}

export interface RestoreNotesResult {
  notes: NoteRestore[];
  totals: { restored: number; not_suppressed: number; not_found: number };
  tx?: number;
}

/**
 * Restore up to DELETE_NOTE_MAX suppressed notes: retract the marker, and
 * only the marker, pinned to the notes scope it was asserted in. A note
 * never suppressed is `not_suppressed`; an id with no current facts (never
 * a note, or purged) is `not_found` — a purge is not undone here. A
 * non-Note or a protected note refuses the call, writing nothing. One
 * admit for the whole call.
 */
export async function restoreNotes(
  dial: ChaosDial,
  scope: string,
  input: { ids: string[] },
  types: ReadonlySet<string> = NOTE_TYPES,
): Promise<RestoreNotesResult | DeleteNotesError> {
  const invalid = validate(input.ids);
  if (invalid !== null) return invalid;
  if (!needsPlacedReads(dial)) return UNSUPPORTED;

  const home = graphToken(scope);
  const hidden = await suppressedNotes(dial, scope);
  const notes: NoteRestore[] = [];
  const refused: DeleteRefusal[] = [];
  const ops: ChaosOp[] = [];
  for (const id of input.ids) {
    const all = await dial.placedEdges(id);
    const out = all.filter((e) => !SYSTEM_PREDICATES.has(e.predicate));
    if (out.length === 0) {
      notes.push({ node_id: id, status: "not_found" });
      continue;
    }
    const refusal = await guard(dial, id, out, all, types);
    if (refusal !== null) {
      refused.push(refusal);
      continue;
    }
    if (!hidden.has(id)) {
      notes.push({ node_id: id, status: "not_suppressed" });
      continue;
    }
    ops.push(opRemove(id, SUPPRESSED, { toLiteral: SUPPRESSED_VALUE }, home));
    notes.push({ node_id: id, status: "restored" });
  }
  if (refused.length > 0) {
    return {
      code: "batch_refused",
      detail: `${String(refused.length)} of ${String(input.ids.length)} id(s) refused; nothing was written`,
      refused,
    };
  }
  let tx: number | undefined;
  if (ops.length > 0) {
    const res = await dial.admit(ops, scope);
    if (!res.admitted) {
      return {
        code: "admit_refused",
        detail: "the gate refused the restore; nothing was written",
        violations: res.violations,
      };
    }
    tx = res.tx;
  }
  const count = (s: NoteRestore["status"]) =>
    notes.filter((n) => n.status === s).length;
  return {
    notes,
    totals: {
      restored: count("restored"),
      not_suppressed: count("not_suppressed"),
      not_found: count("not_found"),
    },
    ...(tx !== undefined ? { tx } : {}),
  };
}

/** Drop the suppressed ids from a listing, keeping its order. */
export function visible<T>(
  items: readonly T[],
  hidden: ReadonlySet<string>,
  idOf: (item: T) => string,
): T[] {
  return items.filter((item) => !hidden.has(idOf(item)));
}
