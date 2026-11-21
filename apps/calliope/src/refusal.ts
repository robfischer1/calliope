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
