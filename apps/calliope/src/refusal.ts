/**
 * The fleet's one refusal form (stellar-core F17): an isError tool result whose
 * structured content is exactly `{code, detail}` (foundry-dies
 * schema/refusal.schema.json). `code` is a snake_case member of the fleet
 * registry, foundry-dies contracts/refusal-codes.toml, where every file that
 * spells one is a declared use of owner `calliope`.
 *
 * The verbs build their refusals as plain objects keyed `code` (the internal
 * result unions discriminate on it) and this module is the only place that
 * turns one into a wire result. The strict form carries nothing else, so a
 * refusal that held more (the gate's violations, the ids a batch refused, the
 * notes that landed first) says it in `detail`.
 */

/** A refusal as the verbs build it; the extras are folded into `detail`. */
export interface RefusalLike {
  code: string;
  detail: string;
  /** The gate's violations on an admit refusal. */
  violations?: unknown[] | undefined;
  /** What a batch refused, each id with its own code and sentence. */
  refused?: readonly { code: string; detail: string }[] | undefined;
  /** The notes that landed before an admit refusal. */
  notes?: readonly { node_id: string }[] | undefined;
}

/** The wire body of a refusal: `{code, detail}`, nothing else. */
export function refusalBody(r: RefusalLike): { code: string; detail: string } {
  let detail = r.detail;
  if (r.refused !== undefined && r.refused.length > 0) {
    detail += ` (${r.refused.map((x) => `${x.code}: ${x.detail}`).join("; ")})`;
  }
  if (r.notes !== undefined && r.notes.length > 0) {
    detail += ` (landed first: ${r.notes.map((n) => n.node_id).join(", ")})`;
  }
  if (r.violations !== undefined && r.violations.length > 0) {
    detail += ` (violations: ${JSON.stringify(r.violations)})`;
  }
  return { code: r.code, detail };
}

/** The tool result a refusal travels as. */
export interface RefusalResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: { code: string; detail: string };
  isError: true;
}

/** Turn a refusal into the isError result the wire carries. */
export function refusalResult(r: RefusalLike): RefusalResult {
  const body = refusalBody(r);
  return {
    content: [{ type: "text", text: `${body.code}: ${body.detail}` }],
    structuredContent: body,
    isError: true,
  };
}

/** Refuse a call: `refuse("bad_args", "send exactly one of ops or replacements")`. */
export function refuse(code: string, detail: string): RefusalResult {
  return refusalResult({ code, detail });
}
