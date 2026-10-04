/**
 * Note properties — a note's frontmatter, landed as graph edges.
 *
 * The notes importer strips a vault note's YAML fence from the body (the
 * body is prose), so before this verb the metadata had nowhere to go: the
 * dissolve archive row keeps only `schema_type`/`subject`/`created`/
 * `updated`, and the importer's Journal/Brain Soup path kept nothing at all.
 * `set_properties` is the write half. The CALLER maps YAML to predicates and
 * resolves wikilinks to node tokens (it holds the vault and the extent);
 * Calliope validates and reconciles, so every frontmatter write rides one
 * gated, idempotent path, the same way `create_note` owns the mint.
 *
 * Semantics, per predicate NAMED in the call: the note's current values for
 * that predicate become exactly the given set (missing values asserted,
 * extra ones retracted). Predicates the call does not name are untouched.
 * One admit batch; zero ops is zero calls, so a re-run is a read and a no-op.
 *
 * - `tags` ride the C9 tag path (hasTag edge + mirror row, `explicit`
 *   provenance), so `list_tags` and the A21 `tag:` lens see them. Additive,
 *   like every explicit write. Junk (hex-colour-shaped) tags are skipped and
 *   reported, not fatal: one stray value must not cost a note its metadata.
 * - `frontmatter` is the source YAML verbatim, kept as one literal so the
 *   original stays recoverable byte-for-byte (`export_note` and
 *   `materialize_note` serve it back).
 * - `retract: true` is the revert form: it removes exactly the named values
 *   (and explicit-sourced tags) and asserts nothing.
 *
 * Reserved predicates are refused: identity, structure and the dissolve
 * provenance contract each have one writer already, and a second writer on
 * the same predicate would flap.
 */

import {
  type ChaosDial,
  ChaosClientError,
  type NodeEdge,
  opAdd,
  opRemove,
  type ChaosOp,
} from "./chaos-client.js";
import type { TagStore } from "./tag-store.js";
import { isJunkTag, normalizeTag } from "./tags.js";
import { HAS_TAG, NOTE_KIND, reconcileNoteTags } from "./mcp/tools.js";

/** The literal that carries the source YAML. */
export const FRONTMATTER = "frontmatter";

/**
 * Predicates another writer owns. Identity + structure (create_note, the
 * tree), the tag path, the dissolve sink's provenance attributes, and the
 * migration plumbing.
 */
export const RESERVED_PREDICATES: ReadonlySet<string> = new Set([
  "hasName",
  "hasType",
  "parent",
  "kind",
  HAS_TAG,
  FRONTMATTER,
  "tree_member",
  "tree_position",
  "tree_content",
  "anchorsRole",
  "source_path",
  "raw_hash",
  "source_kind",
  "mtime",
  "ctime",
  "title",
  "schema_type",
  "file_path",
  "dissolved_at",
  "document_id",
  "sections_migrated",
  "migration_provenance",
  "migrated_from_section",
  "migrated_container_id",
  "comments_on",
  "isArchived",
  "ownedBy",
]);

/** One value: a literal string, or a node token (a resolved wikilink). */
export type PropertyValue = { literal: string } | { node: string };

export interface Property {
  predicate: string;
  values: PropertyValue[];
}

export interface SetPropertiesInput {
  container_id: string;
  properties?: Property[] | undefined;
  tags?: string[] | undefined;
  frontmatter?: string | undefined;
  retract?: boolean | undefined;
}

export interface SetPropertiesResult {
  node_id: string;
  /** Edges asserted, as `predicate=value` (node values are tokens). */
  added: string[];
  /** Edges retracted, same spelling. */
  removed: string[];
  tags_added: string[];
  tags_removed: string[];
  /** Tags dropped by the F11 junk rule. */
  tags_skipped: string[];
  /** The graph transaction the edge batch landed as, when one did. */
  tx?: number;
}

export interface SetPropertiesError {
  error:
    | "not_a_note"
    | "bad_predicate"
    | "bad_value"
    | "bad_target"
    | "admit_refused";
  detail: string;
  violations?: unknown[];
}

export function isSetPropertiesError(
  r: SetPropertiesResult | SetPropertiesError,
): r is SetPropertiesError {
  return "error" in r;
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** One edge's identity for set arithmetic: domain-tagged so a literal that
 *  happens to look like a token never equals a node edge. */
function keyOf(isNode: boolean, value: string): string {
  return JSON.stringify([isNode, value]);
}

function spell(predicate: string, value: string): string {
  return `${predicate}=${value}`;
}

/** Validate the call before any read beyond the note check. */
function validate(input: SetPropertiesInput): SetPropertiesError | null {
  for (const p of input.properties ?? []) {
    const name = p.predicate.trim();
    if (name === "" || name !== p.predicate) {
      return {
        error: "bad_predicate",
        detail: `predicate ${JSON.stringify(p.predicate)} must be non-empty and untrimmed`,
      };
    }
    if (RESERVED_PREDICATES.has(name)) {
      return {
        error: "bad_predicate",
        detail: `${name} is reserved — another writer owns it`,
      };
    }
    for (const v of p.values) {
      if ("node" in v) {
        if (!TOKEN_RE.test(v.node)) {
          return {
            error: "bad_target",
            detail: `${name}: ${v.node} is not a 64-hex node token`,
          };
        }
      } else if (v.literal === "") {
        return { error: "bad_value", detail: `${name}: empty literal` };
      }
    }
  }
  return null;
}

/** The predicate → desired-value plan, frontmatter folded in. */
function desiredOf(input: SetPropertiesInput): Map<string, PropertyValue[]> {
  const desired = new Map<string, PropertyValue[]>();
  for (const p of input.properties ?? []) {
    desired.set(p.predicate, [
      ...(desired.get(p.predicate) ?? []),
      ...p.values,
    ]);
  }
  if (input.frontmatter !== undefined) {
    desired.set(FRONTMATTER, [{ literal: input.frontmatter }]);
  }
  return desired;
}

function edgeOps(
  nodeId: string,
  current: NodeEdge[],
  desired: Map<string, PropertyValue[]>,
  retract: boolean,
): { ops: ChaosOp[]; added: string[]; removed: string[] } {
  const ops: ChaosOp[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [predicate, values] of desired) {
    const standing = current.filter((e) => e.predicate === predicate);
    const have = new Map<string, NodeEdge>(
      standing.map((e) => [keyOf(e.isNode, e.value), e]),
    );
    const want = new Map<string, PropertyValue>(
      values.map((v) => [
        "node" in v ? keyOf(true, v.node) : keyOf(false, v.literal),
        v,
      ]),
    );
    if (retract) {
      for (const [k, v] of want) {
        if (!have.has(k)) continue;
        const value = "node" in v ? v.node : v.literal;
        ops.push(
          opRemove(
            nodeId,
            predicate,
            "node" in v ? { toNode: value } : { toLiteral: value },
          ),
        );
        removed.push(spell(predicate, value));
      }
      continue;
    }
    for (const [k, e] of have) {
      if (want.has(k)) continue;
      ops.push(
        opRemove(
          nodeId,
          predicate,
          e.isNode ? { toNode: e.value } : { toLiteral: e.value },
        ),
      );
      removed.push(spell(predicate, e.value));
    }
    for (const [k, v] of want) {
      if (have.has(k)) continue;
      const value = "node" in v ? v.node : v.literal;
      ops.push(
        opAdd(
          nodeId,
          predicate,
          "node" in v ? { toNode: value } : { toLiteral: value },
        ),
      );
      added.push(spell(predicate, value));
    }
  }
  return { ops, added, removed };
}

/** Remove explicit-sourced tags (the revert form). Inline rows are the
 *  body's, and never this verb's to take. */
async function retractTags(
  dial: ChaosDial,
  scope: string,
  store: TagStore,
  nodeId: string,
  tags: string[],
): Promise<string[]> {
  const standing = await store.byNode(nodeId);
  const explicit = new Set(
    standing.filter((r) => r.source === "explicit").map((r) => r.tag),
  );
  const gone = [...new Set(tags)].filter((t) => explicit.has(t)).sort();
  if (gone.length === 0) return [];
  const res = await dial.admit(
    gone.map((t) => opRemove(nodeId, HAS_TAG, { toLiteral: t })),
    scope,
  );
  if (!res.admitted) {
    throw new ChaosClientError(
      `set_properties: the gate refused the tag retraction for ${nodeId}`,
      "admit_refused",
      res.violations,
    );
  }
  for (const t of gone) await store.remove(nodeId, t);
  return gone;
}

/** The verb body. */
export async function setProperties(
  dial: ChaosDial,
  scope: string,
  tagStore: TagStore | undefined,
  input: SetPropertiesInput,
): Promise<SetPropertiesResult | SetPropertiesError> {
  const invalid = validate(input);
  if (invalid !== null) return invalid;

  const nodeId = input.container_id;
  const current = await dial.edges(nodeId);
  if (
    !current.some((e) => e.predicate === "hasType" && e.value === NOTE_KIND)
  ) {
    return {
      error: "not_a_note",
      detail: `${nodeId} carries no hasType=${NOTE_KIND} edge`,
    };
  }

  const targets = [
    ...new Set(
      (input.properties ?? []).flatMap((p) =>
        p.values.flatMap((v) => ("node" in v ? [v.node] : [])),
      ),
    ),
  ];
  if (targets.length > 0 && input.retract !== true) {
    const known = await dial.resolveNodes(targets);
    const missing = targets.find((t) => !(t in known));
    if (missing !== undefined) {
      return {
        error: "bad_target",
        detail: `${missing} is not on the node dictionary`,
      };
    }
  }

  const retract = input.retract === true;
  const { ops, added, removed } = edgeOps(
    nodeId,
    current,
    desiredOf(input),
    retract,
  );
  let tx: number | undefined;
  if (ops.length > 0) {
    const res = await dial.admit(ops, scope);
    if (!res.admitted) {
      return {
        error: "admit_refused",
        detail: `the gate refused the property batch for ${nodeId}`,
        violations: res.violations,
      };
    }
    tx = res.tx;
  }

  const normalized = (input.tags ?? [])
    .filter((t) => t.trim() !== "")
    .map(normalizeTag);
  // Junk is reported here and kept out downstream: the C9 reconcile's F11
  // chokepoint never admits it, and a retraction only ever finds rows that
  // reconcile wrote.
  const tagsSkipped = normalized.filter(isJunkTag);
  let tagsAdded: string[] = [];
  let tagsRemoved: string[] = [];
  if (tagStore !== undefined && normalized.length > 0) {
    if (retract) {
      tagsRemoved = await retractTags(
        dial,
        scope,
        tagStore,
        nodeId,
        normalized,
      );
    } else {
      const r = await reconcileNoteTags(dial, scope, tagStore, nodeId, {
        explicit: normalized,
      });
      tagsAdded = r.added;
    }
  }

  return {
    node_id: nodeId,
    added,
    removed,
    tags_added: tagsAdded,
    tags_removed: tagsRemoved,
    tags_skipped: [...new Set(tagsSkipped)].sort(),
    ...(tx !== undefined ? { tx } : {}),
  };
}

/** The `frontmatter` literal on a note's edges, or null. */
export function frontmatterOf(edges: readonly NodeEdge[]): string | null {
  const hit = edges.find((e) => e.predicate === FRONTMATTER && !e.isNode);
  return hit === undefined ? null : hit.value;
}

/**
 * Re-attach the source YAML to an exported body: `---\n{yaml}\n---` as the
 * leading block, unless the body already opens with a fence (a note whose
 * import kept its frontmatter in the prose).
 */
export function withFrontmatter(markdown: string, yaml: string | null): string {
  if (yaml === null || markdown.startsWith("---\n") || markdown === "---") {
    return markdown;
  }
  const fence = `---\n${yaml}\n---`;
  return markdown === "" ? fence : `${fence}\n\n${markdown}`;
}
