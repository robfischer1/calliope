/**
 * Slot facts — the metadata that rides ON a Block slot (Glaucus Threads as
 * Calliope containers). A thread segment is a slot like a note's block; who
 * wrote it, in which session, what it quotes and links are facts and edges
 * on that slot, written in the SAME admit batch that births it.
 *
 * The predicate set is CLOSED: the verb cannot be used to write an
 * arbitrary edge. Persona / Session / Window / Moment / Checkpoint have no
 * graph nodes yet, so every node-valued predicate accepts EITHER an existing
 * 64-hex node token OR a literal placeholder (a scalar where the node does
 * not exist yet); a read says which form each fact is.
 */

import { createHash } from "node:crypto";
import {
  type ChaosOp,
  type NodeEdge,
  type QuadRow,
  opAdd,
  opRemove,
  scopeHash,
} from "./chaos-client.js";

/** The closed predicate allow-list. */
export const SLOT_FACT_PREDICATES = [
  "authoredBy",
  "writtenIn",
  "fromCheckpoint",
  "quotes",
  "links",
  "writtenAt",
  "authorKind",
  "contentHash",
  "signedAs",
  "inSeat",
  "authored",
  "legacyId",
  "spanFrom",
  "spanTo",
  "turnsDigest",
] as const;
export type SlotFactPredicate = (typeof SLOT_FACT_PREDICATES)[number];

/** Predicates whose object is a node (or its literal placeholder). */
const NODE_VALUED: ReadonlySet<string> = new Set([
  "authoredBy",
  "writtenIn",
  "fromCheckpoint",
  "quotes",
  "links",
  "authored",
]);
/** May appear more than once on a slot. */
const REPEATABLE: ReadonlySet<string> = new Set([
  "quotes",
  "links",
  "authored",
]);
/** What an `update` may carry: a rewrite replaces the hash and may add to
 *  the repeatable edges; birth-only identity (who/where/when) is never
 *  rewritten by an edit. A segment's turn window (spanFrom, spanTo,
 *  turnsDigest) may be added by an update: glaucus backfills it onto blocks
 *  written before it stored one (scotty43-001). */
const UPDATABLE: ReadonlySet<string> = new Set([
  "contentHash",
  "quotes",
  "links",
  "authored",
  "spanFrom",
  "spanTo",
  "turnsDigest",
]);

const HEX64 = /^[0-9a-f]{64}$/;

/** One fact to write on a slot: exactly one of `node` / `literal`. */
export interface SlotFact {
  /** One of {@link SLOT_FACT_PREDICATES} — checked at write time. */
  predicate: string;
  /** An existing node's 64-hex token. */
  node?: string;
  /** A literal — the placeholder form where the node does not exist yet. */
  literal?: string;
  /** `writtenAt` only: `instant` (default) or `wallclock`. */
  dtype?: string;
}

/** A fact as a read answers it. */
export interface BlockFact {
  predicate: string;
  /** Which object domain the fact holds. */
  form: "node" | "literal";
  value: string;
}

/** A caller error in `facts` — surfaced as `bad_args`, nothing written. */
export class SlotFactError extends Error {
  readonly code = "bad_args";
  constructor(message: string) {
    super(message);
    this.name = "SlotFactError";
  }
}

/** sha256 hex of a slot's text (utf8). */
export function textHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Check one slot's facts against the allow-list and the slot's text.
 * Returns the facts normalised: a `contentHash` without a literal gets the
 * computed one. Throws {@link SlotFactError} on any violation.
 */
export function validateSlotFacts(
  facts: readonly SlotFact[],
  text: string,
  mode: "add" | "update",
): SlotFact[] {
  const seen = new Set<string>();
  const out: SlotFact[] = [];
  for (const f of facts) {
    const p: string = f.predicate;
    if (!(SLOT_FACT_PREDICATES as readonly string[]).includes(p)) {
      throw new SlotFactError(
        `facts: predicate ${JSON.stringify(p)} is not allowed ` +
          `(allowed: ${SLOT_FACT_PREDICATES.join(", ")})`,
      );
    }
    if (mode === "update" && !UPDATABLE.has(p)) {
      throw new SlotFactError(
        `facts: ${p} is set when the block is added; an update may carry ` +
          `only ${[...UPDATABLE].join(", ")}`,
      );
    }
    const computed = p === "contentHash" && f.node === undefined;
    if (!computed && (f.node === undefined) === (f.literal === undefined)) {
      throw new SlotFactError(
        `facts: ${p} needs exactly one of node or literal`,
      );
    }
    if (f.node !== undefined) {
      if (!NODE_VALUED.has(p)) {
        throw new SlotFactError(`facts: ${p} takes a literal, not a node`);
      }
      if (!HEX64.test(f.node)) {
        throw new SlotFactError(`facts: ${p} node must be a 64-hex token`);
      }
    }
    if (f.literal !== undefined && f.literal === "") {
      throw new SlotFactError(`facts: ${p} literal is empty`);
    }
    if (f.dtype !== undefined) {
      if (p !== "writtenAt") {
        throw new SlotFactError(`facts: dtype applies only to writtenAt`);
      }
      if (f.dtype !== "instant" && f.dtype !== "wallclock") {
        throw new SlotFactError(
          `facts: writtenAt dtype must be instant or wallclock`,
        );
      }
    }
    if (!REPEATABLE.has(p)) {
      if (seen.has(p)) {
        throw new SlotFactError(`facts: ${p} appears more than once`);
      }
      seen.add(p);
    }
    if (p === "legacyId" && !/^\d+$/.test(f.literal ?? "")) {
      throw new SlotFactError("facts: legacyId must be a non-negative integer");
    }
    // A turn window's ends are seqs; an empty window ends one before it
    // starts, so the first one can end at -1.
    if (
      (p === "spanFrom" || p === "spanTo") &&
      !/^-?\d+$/.test(f.literal ?? "")
    ) {
      throw new SlotFactError(`facts: ${p} must be an integer seq`);
    }
    if (p === "turnsDigest" && !/^[0-9a-f]{16}$/.test(f.literal ?? "")) {
      throw new SlotFactError("facts: turnsDigest must be 16 lower-case hex");
    }
    if (p === "quotes" && f.literal?.startsWith("{") === true) {
      checkQuote(f.literal);
    }
    if (p === "contentHash") {
      const want = textHash(text);
      if (f.literal !== undefined && f.literal.toLowerCase() !== want) {
        throw new SlotFactError(
          `facts: contentHash ${f.literal} does not match the text ` +
            `(sha256 ${want}); nothing written`,
        );
      }
      out.push({ predicate: "contentHash", literal: want });
      continue;
    }
    if (p === "writtenAt") {
      out.push({ ...f, dtype: f.dtype ?? "instant" });
      continue;
    }
    out.push({ ...f });
  }
  return out;
}

/** A JSON-object quote must carry the four members that identify a Moment. */
function checkQuote(literal: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(literal);
  } catch {
    throw new SlotFactError(
      "facts: quotes literal starts with { but is not JSON",
    );
  }
  const o = (typeof parsed === "object" ? parsed : null) as Record<
    string,
    unknown
  > | null;
  for (const k of ["session_uuid", "seq", "ts", "sha"]) {
    if (o === null || !(k in o)) {
      throw new SlotFactError(
        `facts: a JSON quote needs session_uuid, seq, ts and sha (missing ${k})`,
      );
    }
  }
}

/** The addEdge ops for validated facts on `subject` (a token or a
 *  batch-local label). */
export function slotFactOps(
  subject: string,
  facts: readonly SlotFact[],
): ChaosOp[] {
  return facts.map((f) =>
    opAdd(
      subject,
      f.predicate,
      f.node !== undefined
        ? { toNode: f.node }
        : {
            toLiteral: f.literal ?? "",
            ...(f.dtype !== undefined ? { dtype: f.dtype } : {}),
          },
    ),
  );
}

/** Retract a slot's current `contentHash` literals (the edit replaces it). */
export function retractContentHashOps(
  slot: string,
  edges: readonly NodeEdge[],
): ChaosOp[] {
  return edges
    .filter((e) => e.predicate === "contentHash" && e.domain === "scalar")
    .map((e) => opRemove(slot, "contentHash", { toLiteral: e.value }));
}

const ALLOWED: ReadonlySet<string> = new Set(SLOT_FACT_PREDICATES);

/** Facts off a slot's HEAD edges. Read-back order is deterministic, not the
 *  write order: predicate (allow-list order), then value bytewise. A caller
 *  that needs a list kept in order puts the ordinal in the literal. */
export function factsFromEdges(edges: readonly NodeEdge[]): BlockFact[] {
  const out: BlockFact[] = [];
  for (const e of edges) {
    if (!ALLOWED.has(e.predicate) || e.domain === "blob") continue;
    out.push({
      predicate: e.predicate,
      form: e.domain === "node" ? "node" : "literal",
      value: e.value,
    });
  }
  return sortFacts(out);
}

/**
 * Facts off raw quads (an as-of or batch read). A scalar object is its
 * content-hash and resolves through `values`; an object that does not
 * resolve is a node token.
 */
export function factsFromQuads(
  rows: readonly QuadRow[],
  values: Readonly<Record<string, string>>,
): Map<string, BlockFact[]> {
  const byHash = new Map(SLOT_FACT_PREDICATES.map((p) => [scopeHash(p), p]));
  const out = new Map<string, BlockFact[]>();
  for (const r of rows) {
    const predicate = byHash.get(r.p);
    if (predicate === undefined || r.o.startsWith("blob:")) continue;
    const literal = values[r.o];
    const fact: BlockFact =
      literal !== undefined
        ? { predicate, form: "literal", value: literal }
        : { predicate, form: "node", value: r.o };
    const list = out.get(r.s) ?? [];
    list.push(fact);
    out.set(r.s, list);
  }
  for (const [s, list] of out) out.set(s, sortFacts(list));
  return out;
}

/** The scalar hashes of fact objects among `rows` (to resolve in one call). */
export function factScalarHashes(rows: readonly QuadRow[]): string[] {
  const preds = new Set(SLOT_FACT_PREDICATES.map((p) => scopeHash(p)));
  return rows
    .filter((r) => preds.has(r.p) && !r.o.startsWith("blob:"))
    .map((r) => r.o);
}

function sortFacts(facts: BlockFact[]): BlockFact[] {
  return facts.sort(
    (a, b) =>
      SLOT_FACT_PREDICATES.indexOf(a.predicate as SlotFactPredicate) -
        SLOT_FACT_PREDICATES.indexOf(b.predicate as SlotFactPredicate) ||
      (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
  );
}
