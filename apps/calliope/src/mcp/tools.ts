/**
 * Calliope-MCP tool handlers — the prose facet of the urania substrate.
 *
 * clotho's MCP is the *work/graph* facet (board CRUD over the same nodes);
 * Calliope-MCP is the *body/prose* facet: it writes the node *bodies*
 * (`note --hasPart--> section --text/order_key-->`). The two MCPs are peers
 * over one substrate — clotho builds the plan graph, Calliope writes the plan
 * prose on those same nodes.
 *
 * These handlers are pure functions of a {@link BodyClient}: every read/write
 * goes through the exact client (and body-model mapping) Tantalus and the editor
 * use, so the MCP cannot drift from the lib. Tests drive them over
 * {@link FixtureBodyClient}; production drives them over a wired
 * {@link UraniaBodyClient}. No model is reimplemented here.
 */

import type {
  AuthoredBy,
  BodyClient,
  NoteBodies,
  CommentThread,
  RevisionMeta,
  Section,
  SectionInput,
  SectionOp,
} from "../types.js";
import {
  type ChaosDial,
  ChaosClientError,
  ensureNotesRoot,
  isNodeToken,
  opAdd,
  opCreate,
  opRemove,
} from "../chaos-client.js";
import {
  computeTagDelta,
  extractInlineTags,
  isJunkTag,
  normalizeTag,
} from "../tags.js";
import type { TagCount, TagStore } from "../tag-store.js";
import { suppressedNotes, visible } from "../note-suppress.js";
import type { FocusRegister } from "../focus-register.js";
import type { BodyPointer } from "../types.js";

/** A section as the MCP returns it (the lib {@link Section} shape, verbatim). */
export interface ToolSection {
  id: string;
  text: string;
  orderKey: string;
}

/** `read_body` result: the node's sections, sorted by `orderKey` (COLLATE "C"). */
export interface ReadBodyResult {
  sections: ToolSection[];
}

/** `write_body` / coarse-save result. */
export interface WriteBodyResult {
  ok: true;
  count: number;
}

/** `append_section` result: the appended section plus the new body length. */
export interface AppendSectionResult {
  section: ToolSection;
  count: number;
}

/** `edit_section` result: the (copy-on-write) section after the edit. */
export interface EditSectionResult {
  section: ToolSection;
}

/** One `apply_section_ops` op as it rides the wire (snake_case inputs, the
 *  tool convention). */
export interface WireSectionOp {
  op: "add" | "update" | "delete" | "reorder";
  section_id?: string;
  text?: string;
  order_key?: string;
}

/** `apply_section_ops` result: the post-apply body + per-op alignment. */
export interface ApplySectionOpsToolResult {
  sections: ToolSection[];
  applied: { id: string; orderKey: string }[];
}

/** `read_body_revisions` result: the body's write-events, newest first. */
export interface ReadBodyRevisionsResult {
  revisions: RevisionMeta[];
}

/** `read_body_at` result: the body's sections as of a write-event. */
export interface ReadBodyAtResult {
  revision: string;
  sections: ToolSection[];
}

function toToolSection(s: Section): ToolSection {
  return { id: s.id, text: s.text, orderKey: s.orderKey };
}

/**
 * read_body(node_id) -> { sections: [{ id, text, orderKey }] } sorted by
 * orderKey. A node with no body returns `{ sections: [] }`.
 */
export async function readBody(
  client: BodyClient,
  nodeId: string,
): Promise<ReadBodyResult> {
  const sections = await client.readBody(nodeId);
  return { sections: sections.map(toToolSection) };
}

/**
 * write_body(node_id, sections) -> coarse-save: replace the whole body with
 * `sections` (in display order); the substrate mints fresh `order_key`s and
 * copy-on-writes changed prose. Returns `{ ok, count }`.
 */
export async function writeBody(
  client: BodyClient,
  nodeId: string,
  sections: SectionInput[],
  authoredBy?: AuthoredBy,
  kafkaOffset?: number,
): Promise<WriteBodyResult> {
  await client.saveBody(nodeId, sections, authoredBy, kafkaOffset);
  return { ok: true, count: sections.length };
}

/** Decode one wire op into the lib {@link SectionOp}, validating shape. */
function decodeOp(w: WireSectionOp, i: number): SectionOp {
  const need = (field: string): never => {
    throw new Error(
      `apply_section_ops: op[${String(i)}] (${w.op}) is missing ${field}.`,
    );
  };
  if (w.op === "add") {
    return {
      op: "add",
      text: w.text ?? need("text"),
      orderKey: w.order_key ?? need("order_key"),
    };
  }
  if (w.op === "update") {
    return {
      op: "update",
      sectionId: w.section_id ?? need("section_id"),
      text: w.text ?? need("text"),
      ...(w.order_key !== undefined ? { orderKey: w.order_key } : {}),
    };
  }
  if (w.op === "delete") {
    return { op: "delete", sectionId: w.section_id ?? need("section_id") };
  }
  return {
    op: "reorder",
    sectionId: w.section_id ?? need("section_id"),
    orderKey: w.order_key ?? need("order_key"),
  };
}

/**
 * apply_section_ops(node_id, ops) -> { sections, applied } — the A11
 * block-grain transactional write. ALL ops apply or none; per-op semantics
 * are the `edit_section` copy-on-write engine generalized. A stale
 * `section_id` rejects with a `stale_section` error (the editor's
 * compare-before-write race backstop). Requires a {@link BodyClient} with
 * the optional `applySectionOps` — the store-backed backends implement it;
 * the fs backend deliberately does NOT (0.14: files carry no durable
 * section identity, and the editor degrades to whole-body writes).
 */
export async function applySectionOps(
  client: BodyClient,
  nodeId: string,
  ops: WireSectionOp[],
  authoredBy?: AuthoredBy,
  kafkaOffset?: number,
): Promise<ApplySectionOpsToolResult> {
  const decoded = ops.map((w, i) => decodeOp(w, i));
  const result = await client.applySectionOps(
    nodeId,
    decoded,
    authoredBy,
    kafkaOffset,
  );
  return {
    sections: result.sections.map(toToolSection),
    applied: result.applied.map((a) => ({ id: a.id, orderKey: a.orderKey })),
  };
}

/**
 * read_body_revisions(node_id, limit?) -> { revisions } — the body's stored
 * write-events, newest first (A8's history surface). Requires a
 * {@link BodyClient} implementing the optional `readRevisions`; rejects with
 * a clear error otherwise (mirrors the `edit_section` guard).
 */
export async function readBodyRevisions(
  client: BodyClient,
  nodeId: string,
  limit?: number,
): Promise<ReadBodyRevisionsResult> {
  const revisions = await client.readRevisions(nodeId, limit);
  return { revisions };
}

/**
 * read_body_at(node_id, revision) -> { revision, sections } — the body
 * reconstructed as of the write-event `revision` (a value returned by
 * `read_body_revisions`). A revision predating the body yields `[]`.
 */
export async function readBodyAt(
  client: BodyClient,
  nodeId: string,
  revision: string,
): Promise<ReadBodyAtResult> {
  const sections = await client.readRevisionAt(nodeId, revision);
  return { revision, sections: sections.map(toToolSection) };
}

// ── F3: the block-native verb surface ────────────────────────────────────────

/** A single-block result — the block verbs' common success shape. */
export interface BlockResult {
  block: ToolSection;
}

/** `read_block` structured miss — surfaced, never thrown (a read miss is an
 *  answer, not a fault; write-path staleness still throws `stale_section`). */
export interface BlockMiss {
  code: "not_found";
  detail: string;
}

/** `delete_block` result. */
export interface DeleteBlockResult {
  ok: true;
  deleted: { id: string; orderKey: string };
}

/** `split_block` result: the two children, in order. */
export interface SplitBlockResult {
  blocks: [ToolSection, ToolSection];
}

/** One entry of a section-container index (F5): the address, never the prose. */
export interface ContainerBlockRef {
  id: string;
  /** The block's first non-empty line, trimmed, capped at 80 chars. */
  title: string;
  /** The block's character count (UTF-16 units of its text). */
  chars: number;
  /** The fractional order key (byte-ordered). */
  order_key: string;
}

/** `list_blocks` result for the node family. */
export interface ListContainerBlocksResult {
  container_id: string;
  kind: "node";
  block_count: number;
  blocks: ContainerBlockRef[];
}

// ── 026: comments — a block plus a commentsOn edge ───────────────────────────

/** `create_comment` result: the comment block + where it lives. */
export interface CreateCommentResult {
  comment: ToolSection;
  target_id: string;
  comment_container_id: string;
}

/** `list_comments` result: threads keyed by target. */
export interface ListCommentsResult {
  threads: CommentThread[];
}

// ── C8: the note-native mint ─────────────────────────────────────────────────

/** `create_note` success: the note's identity (+ whether this call minted it). */
export interface CreateNoteResult {
  node_id: string;
  created: boolean;
}

/** `create_note` structured miss — surfaced, never thrown. */
export interface CreateNoteError {
  code: "bad_args" | "admit_refused" | "suppressed_exists";
  detail: string;
  violations?: unknown[];
  /** `suppressed_exists` only: the hidden note holding the title — the id
   *  `restore_note` takes. */
  node_id?: string;
}

/** Type guard for the miss shape. */
export function isCreateNoteError(
  r: CreateNoteResult | CreateNoteError,
): r is CreateNoteError {
  return "code" in r;
}

/** The kind + type label a minted note carries. */
export const NOTE_KIND = "Note";

/**
 * create_note(title, parent?, tags?, type?) -> { node_id, created } — the
 * C8 mint.
 *
 * A title held only by SUPPRESSED notes refuses `suppressed_exists` with the
 * hidden note's id — `restore_note` is the way back; nothing is minted.
 *
 * Reuse-first (the F2 identity contract: `createNode` never dedups, so the
 * name is looked up before any mint — `(Note, title)` IS the idempotency key);
 * on a miss, the two-admit mint (createNode → `minted[0]`, then the edge
 * batch: `hasName`, `hasType` (input.type, default "Note"), `parent`) on
 * the notes scope. A parentless note parents to the ensured "Notes" root —
 * orphan-safety
 * regardless of caller. `tags` is validated and otherwise inert (C9 wires the
 * `hasTag` write). No section rows mint — the body is the node's (empty)
 * section set, readable immediately; first write attaches sections.
 */
export async function createNote(
  dial: ChaosDial,
  scope: string,
  input: { title: string; parent?: string; tags?: string[]; type?: string },
  tagStore?: TagStore,
): Promise<CreateNoteResult | CreateNoteError> {
  const title = input.title.trim();
  // The hasType edge only: the node's kind stays Note, because `(Note,
  // title)` is the reuse key below — a different kind would mint a twin on
  // the next call. A non-Note type (a mnemosyne body is "Memory") falls out
  // of everything keyed on hasType=Note: the inline-tag reconcile,
  // set_properties, and the notes DocumentStore listing.
  const hasType = input.type ?? NOTE_KIND;
  if (title.length === 0) {
    return { code: "bad_args", detail: "title must be non-empty" };
  }
  if (input.tags?.some((t) => t.trim() === "")) {
    return { code: "bad_args", detail: "tags must be non-empty strings" };
  }
  // F11: hex-color-shaped tokens are junk on the explicit path too.
  const junk = input.tags?.find((t) => isJunkTag(normalizeTag(t)));
  if (junk !== undefined) {
    return {
      code: "bad_args",
      detail: `tag ${junk} is hex-color-shaped (rejected by the F11 hygiene rule)`,
    };
  }

  // Lazy parent resolve — shared by the mint and the heal-on-reuse paths.
  const resolveParent = async (): Promise<string | CreateNoteError> => {
    if (input.parent === undefined) {
      try {
        return await ensureNotesRoot(dial, scope);
      } catch (err) {
        if (err instanceof ChaosClientError && err.code === "admit_refused") {
          return {
            code: "admit_refused",
            detail: err.message,
            violations: err.violations,
          };
        }
        throw err;
      }
    }
    if (!isNodeToken(input.parent)) {
      return {
        code: "bad_args",
        detail: "parent must be a 64-hex node token",
      };
    }
    const known = await dial.resolveNodes([input.parent]);
    if (!(input.parent in known)) {
      return {
        code: "bad_args",
        detail: `parent ${input.parent} is not on the node dictionary`,
      };
    }
    return input.parent;
  };

  const edgeBatch = (token: string, parent: string) => [
    opAdd(token, "hasName", { toLiteral: title }),
    opAdd(token, "hasType", { toLiteral: hasType }),
    opAdd(token, "parent", { toNode: parent }),
  ];

  const standing = await dial.findByName(NOTE_KIND, title);
  if (standing.length > 0) {
    // A SUPPRESSED note is never handed back: `(Note, title)` is the
    // identity, so reusing it returned `created:false` for a note every
    // listing hides, and minting a twin would break the key. A live holder
    // of the title wins; a title held only by suppressed notes refuses and
    // names the way back.
    const hidden = await suppressedNotes(dial, scope);
    const sorted = [...standing].sort();
    const node = sorted.find((t) => !hidden.has(t));
    if (node === undefined) {
      // standing is non-empty, so every holder is hidden and [0] exists.
      const held = String(sorted[0]);
      return {
        code: "suppressed_exists",
        detail:
          `a suppressed note already holds the title (${held}); ` +
          "restore_note brings it back — create_note will not mint a twin",
        node_id: held,
      };
    }
    // Heal an interrupted mint: a dictionary row whose edge admit never
    // landed (the invisible-row trap) gets its edges re-asserted here, so
    // idempotent re-runs converge instead of returning a broken node.
    const existing = await dial.edges(node);
    if (!existing.some((e) => e.predicate === "hasName")) {
      const parent = await resolveParent();
      if (typeof parent !== "string") {
        return parent;
      }
      const healed = await dial.admit(edgeBatch(node, parent), scope);
      if (!healed.admitted) {
        return {
          code: "admit_refused",
          detail: `the gate refused the healing edge batch for ${node}`,
          violations: healed.violations,
        };
      }
    }
    if (tagStore !== undefined && input.tags !== undefined) {
      await reconcileNoteTags(dial, scope, tagStore, node, {
        explicit: input.tags,
      });
    }
    return { node_id: node, created: false };
  }

  const parent = await resolveParent();
  if (typeof parent !== "string") {
    return parent;
  }

  const mint = await dial.admit([opCreate(NOTE_KIND, title)], scope);
  if (!mint.admitted || mint.minted.length !== 1) {
    return {
      code: "admit_refused",
      detail: "the gate refused the mint",
      violations: mint.violations,
    };
  }
  const [token] = mint.minted;
  if (token === undefined) {
    return {
      code: "admit_refused",
      detail: "the gate admitted but returned no minted token",
      violations: mint.violations,
    };
  }

  const edges = await dial.admit(edgeBatch(token, parent), scope);
  if (!edges.admitted) {
    return {
      code: "admit_refused",
      detail:
        `the gate refused the edge batch for ${token} — the node is a ` +
        "dictionary row without its edges; an identical re-run heals it " +
        "(the reuse path re-asserts the missing edges)",
      violations: edges.violations,
    };
  }

  if (tagStore !== undefined && input.tags !== undefined) {
    await reconcileNoteTags(dial, scope, tagStore, token, {
      explicit: input.tags,
    });
  }

  return { node_id: token, created: true };
}

// ── C9: the tag path ─────────────────────────────────────────────────────────

/** The graph predicate a note's tags ride. */
export const HAS_TAG = "hasTag";

/**
 * Reconcile a note's `hasTag` edges + mirror rows against the given sets.
 * The graph writes first (it is the truth); the mirror follows. Explicit
 * rows survive every inline reconcile (provenance rides the mirror).
 */
export async function reconcileNoteTags(
  dial: ChaosDial,
  scope: string,
  store: TagStore,
  nodeId: string,
  next: { inline?: string[]; explicit?: string[] },
): Promise<{ added: string[]; removed: string[] }> {
  const standing = await store.byNode(nodeId);
  const delta = computeTagDelta(standing, next);
  if (delta.toAdd.length === 0 && delta.toRemove.length === 0) {
    return { added: [], removed: [] };
  }
  const ops = [
    ...delta.toAdd.map((r) => opAdd(nodeId, HAS_TAG, { toLiteral: r.tag })),
    ...delta.toRemove.map((tag) =>
      opRemove(nodeId, HAS_TAG, { toLiteral: tag }),
    ),
  ];
  const res = await dial.admit(ops, scope);
  if (!res.admitted) {
    throw new ChaosClientError(
      `reconcileNoteTags: the gate refused the tag batch for ${nodeId}`,
      "admit_refused",
      res.violations,
    );
  }
  for (const r of delta.toAdd) {
    await store.upsert(nodeId, r.tag, r.source);
  }
  for (const tag of delta.toRemove) {
    await store.remove(nodeId, tag);
  }
  return {
    added: delta.toAdd.map((r) => r.tag),
    removed: delta.toRemove,
  };
}

/**
 * The body-write hook: for a Note-kind node (kind-gated via the node's
 * `hasType` edge — work-node prose never enters the tag path), extract the
 * body's inline tags and reconcile. Reads the CURRENT body from the client
 * so every write shape (coarse, append, edit, block ops, container ops)
 * feeds one path. Answers the delta, or undefined when the node is not a
 * live note and the tag path never ran.
 */
export async function maybeReconcileInlineTags(
  client: NoteBodies,
  dial: ChaosDial,
  scope: string,
  store: TagStore,
  nodeId: string,
): Promise<{ added: string[]; removed: string[] } | undefined> {
  const edges = await dial.edges(nodeId);
  const isNote = edges.some(
    (e) => e.predicate === "hasType" && e.value === NOTE_KIND,
  );
  if (!isNote) {
    return undefined;
  }
  // An ARCHIVED note carries no inline tags. The phdb-migration corpus
  // (2,479 notes on 2026-07-05: OneDrive files, Takeout zips, the iPhone
  // NoteStore, C source, spreadsheets, mail) was keyed `source_path ::
  // file` and stamped isArchived=true as its exclusion predicate — and then
  // this hook ran the tag grammar over every body, minting `#include`,
  // `#ifdef`, `#div/0`, `#n/a`, `#inbox/<gmail label id>` … into the
  // picker's chip row. The predicate means what it says here too.
  if (isArchived(edges)) {
    return undefined;
  }
  const sections = await client.readBody(nodeId);
  const text = sections.map((s) => s.text).join("\n");
  return reconcileNoteTags(dial, scope, store, nodeId, {
    inline: extractInlineTags(text),
  });
}

/** The migration's exclusion predicate (migrate-notes.ts `identityOf`). */
export const IS_ARCHIVED = "isArchived";

/** True when the node's edges carry `isArchived = "true"` (a literal). */
export function isArchived(
  edges: readonly { predicate: string; value: string; isNode: boolean }[],
): boolean {
  return edges.some(
    (e) => e.predicate === IS_ARCHIVED && !e.isNode && e.value === "true",
  );
}

/** What an archived-tag sweep did, or would do. */
export interface ArchivedTagSweep {
  /** Archived notes found on the scope. */
  archived: number;
  /** Archived notes that carried at least one inline row. */
  carriers: number;
  /** Inline rows removed (or, probing, that would be). */
  rows: number;
  /** The distinct tags those rows named. */
  tags: string[];
}

/**
 * Sweep the inline tags off every archived note on the scope — the one-shot
 * repair for the bodies the hook above reconciled before it learned to
 * skip them. Rides `reconcileNoteTags` with an EMPTY inline set, so the
 * explicit rows (folder tags) stay exactly as `computeTagDelta` promises
 * and the graph edge + mirror row go together. `probe` reports without
 * writing.
 */
export async function sweepArchivedTags(
  dial: ChaosDial,
  scope: string,
  store: TagStore,
  probe = false,
): Promise<ArchivedTagSweep> {
  const ids = await dial.findByValue(scope, IS_ARCHIVED, "true");
  const tags = new Set<string>();
  let carriers = 0;
  let rows = 0;
  for (const id of ids) {
    const inline = (await store.byNode(id)).filter(
      (r) => r.source === "inline",
    );
    if (inline.length === 0) continue;
    carriers += 1;
    rows += inline.length;
    for (const r of inline) tags.add(r.tag);
    if (!probe) {
      await reconcileNoteTags(dial, scope, store, id, { inline: [] });
    }
  }
  return { archived: ids.length, carriers, rows, tags: [...tags].sort() };
}

/** `list_by_tag(tag)` — the graph's indexed point lookup, server-side,
 *  minus the suppressed notes unless `includeSuppressed` (a tag rename must
 *  still reach a hidden note, so its tags are right when it is restored). */
export async function listByTag(
  dial: ChaosDial,
  scope: string,
  tag: string,
  includeSuppressed: boolean,
): Promise<{ tag: string; node_ids: string[] }> {
  const norm = normalizeTag(tag);
  const [ids, hidden] = await Promise.all([
    dial.findByValue(scope, HAS_TAG, norm),
    includeSuppressed
      ? Promise.resolve(new Set<string>())
      : suppressedNotes(dial, scope),
  ]);
  return { tag: norm, node_ids: visible(ids, hidden, (id) => id) };
}

/** `list_tags()` — the distinct set with counts (the mirror's enumeration),
 *  not counting the `hidden` (suppressed) notes. */
export async function listTags(
  store: TagStore,
  hidden?: ReadonlySet<string>,
): Promise<{ tags: TagCount[] }> {
  return { tags: await store.distinct(hidden) };
}

/**
 * The compound reference (024/F1 — "Look At This"): a human-readable wikilink
 * PLUS the resolvable address, `[[<title>]] (<id>)`. The wikilink half is
 * display-only (honestly stale after a rename); the id half is the address of
 * record — whatever node id the mounted backend uses, full-length (nothing
 * resolves a prefix). `address_form` says which kind the caller holds.
 */
export interface CompoundReference {
  compound: string;
  wikilink: string;
  id: string;
  title: string;
  address_form: "node" | "path";
}

/** `copy_reference` structured miss — surfaced, never thrown. */
export interface CopyReferenceError {
  code: "not_found";
  detail: string;
}

/** Type guard for the miss shape. */
export function isCopyReferenceError(
  r: CompoundReference | CopyReferenceError,
): r is CopyReferenceError {
  return "code" in r;
}

/**
 * The one formatter of the compound form in this repo. Newlines are stripped
 * from the title (a multi-line wikilink is never valid); everything else is
 * emitted verbatim — the id half carries resolution, so an odd title degrades
 * recognition, never addressability.
 */
export function formatCompoundReference(
  title: string,
  id: string,
): Pick<CompoundReference, "compound" | "wikilink" | "id" | "title"> {
  const clean = title.replace(/[\r\n]+/g, " ").trim();
  const wikilink = `[[${clean}]]`;
  return { compound: `${wikilink} (${id})`, wikilink, id, title: clean };
}

/**
 * copy_reference(node_id) -> the {@link CompoundReference} — graph-backend
 * form. The title is the node's graph name (`resolveNodes`, the same
 * dictionary create_note's reuse path reads); an unknown token is a
 * structured miss, mirroring create_note's error style.
 */
export async function copyReference(
  dial: ChaosDial,
  nodeId: string,
): Promise<CompoundReference | CopyReferenceError> {
  const known = await dial.resolveNodes([nodeId]);
  const title = known[nodeId];
  if (title === undefined) {
    return {
      code: "not_found",
      detail: `${nodeId} resolves to no node on the notes graph`,
    };
  }
  return { ...formatCompoundReference(title, nodeId), address_form: "node" };
}

/**
 * 028 ("Look At This" F5): the `look` result. `focus: null` means no focus
 * has ever arrived — an empty register is an answer, not an error. A
 * present focus carries the pointer, when this star received it, and an
 * HONEST drift verdict computed against the live block at read time:
 *
 *  - `none`    — the excerpt still exists in the block (exact at offsets,
 *                or present elsewhere — offsets are a hint, the TEXT is the
 *                witness; capture space is rendered plain text, storage is
 *                markdown source).
 *  - `drifted` — the block resolves but the excerpt is GONE from it;
 *                `current_text` carries the block's live text so the caller
 *                can compare or diff.
 *  - `gone`    — the block no longer resolves under its node (deleted, or
 *                superseded by a merge that did not preserve the id).
 */
export interface LookResult {
  focus: null | ResolvedPointer;
  /** 029 (F6): the deliberate grain — every pin, arrival order, each with
   *  its own verdict. Empty when nothing is pinned. */
  pins: ResolvedPin[];
}

/** One pointer verified against the live block (the shared verdict shape). */
export interface ResolvedPointer {
  pointer: BodyPointer;
  received_at: string;
  drift: "none" | "drifted" | "gone";
  current_text?: string;
}

/** A resolved pin: the verdict shape plus the pin's identity. */
export interface ResolvedPin extends ResolvedPointer {
  pin_id: string;
}

/**
 * Verify one pointer against the live block — the ONE verdict path both
 * grains use (never forked). The offsets index the RENDERED plain text
 * (theia 059's capture space); the stored block text is markdown source, so
 * the slice only lines up on plain prose. The excerpt is the real witness:
 * an exact slice match OR the excerpt appearing anywhere in the live block
 * both mean the pointed-at prose still exists; only an ABSENT excerpt is
 * drift.
 */
async function resolvePointerAgainstBody(
  client: BodyClient,
  pointer: BodyPointer,
  receivedAt: string,
): Promise<ResolvedPointer> {
  // The block read, inline since F12 retired the block verb family: one
  // body read, the pointed-at section found by id (slots are durable).
  const sections = await client.readBody(pointer.node);
  const hit = sections.find((s) => s.id === pointer.section);
  if (hit === undefined) {
    return { pointer, received_at: receivedAt, drift: "gone" };
  }
  const current = hit.text;
  const drift =
    current.slice(pointer.offsetFrom, pointer.offsetTo) === pointer.text ||
    current.includes(pointer.text)
      ? "none"
      : "drifted";
  return {
    pointer,
    received_at: receivedAt,
    drift,
    ...(drift === "drifted" ? { current_text: current } : {}),
  };
}

/**
 * look() — read the focus register, verify the witnesses. Reading never
 * mutates the register; the drift checks are plain reads of the pointed-at
 * blocks through the same client every other read verb uses.
 */
export async function look(
  client: BodyClient,
  register: FocusRegister,
  hidden: ReadonlySet<string> = new Set(),
): Promise<LookResult> {
  // A suppressed note is off every listing, the attention pointer included:
  // a focus on it reads as no focus, and its pins drop out.
  const entry = register.current();
  const focus =
    entry === null || hidden.has(entry.pointer.node)
      ? null
      : await resolvePointerAgainstBody(
          client,
          entry.pointer,
          entry.receivedAt,
        );
  const pins: ResolvedPin[] = [];
  for (const pin of register.pins()) {
    if (hidden.has(pin.pointer.node)) continue;
    const resolved = await resolvePointerAgainstBody(
      client,
      pin.pointer,
      pin.receivedAt,
    );
    pins.push({ pin_id: pin.pinId, ...resolved });
  }
  return { focus, pins };
}

/** `unpin` structured miss — surfaced, never thrown. */
export interface UnpinError {
  code: "not_found";
  detail: string;
}

/** 029 (F6): remove one pin by id — the conversational "clear pin 2". */
export function unpin(
  register: FocusRegister,
  pinId: string,
): { removed: true; pin_id: string } | UnpinError {
  if (!register.unpin(pinId)) {
    return {
      code: "not_found",
      detail: `${pinId} names no pin in the register`,
    };
  }
  return { removed: true, pin_id: pinId };
}
