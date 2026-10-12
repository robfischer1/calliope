/**
 * The PEP on the dispatcher. The TS peer of stellar-core-go
 * `policy/middleware.go` composed with `witness.Middleware`.
 *
 * In Go the PEP runs INSIDE the witness, so the decision lands on the call's own
 * record. stellar-core-ts's {@link witnessToolCalls} keeps its {@link Call}
 * private, so this is the witness's own handler plus the decision, in one
 * interceptor: one `tools/call` is one record, carrying who called, what the PEP
 * decided and why, and (enforce) that it was refused.
 *
 * Only `tools/call` is decided, as only `tools/call` is witnessed. `initialize`,
 * `tools/list` and every non-MCP route (the probes) never meet the PEP in any mode.
 */

import { pathOf, peerFrom } from "@forge/stellar-core-ts";
import type {
  Decision as RecordedDecision,
  HandlerRegistry,
  RequestLog,
  RequestRecord,
  Sink,
  ToolCallHandler,
} from "@forge/stellar-core-ts";
import { consumerOf } from "./decide.js";
import type { Decision } from "./decide.js";
import { refusal } from "./enforce.js";
import type { Pep } from "./pep.js";

/** What witness mode records for a verdict: nothing was refused, so a deny is
 *  `would_deny` and a consult nobody answered is `would_consult`. */
const WITNESS_DECISION = {
  allow: "allow",
  deny: "would_deny",
  consult: "would_consult",
} as const;

/** The request's `_meta`: the one field of a `tools/call` the library's
 *  request type does not name. */
function metaOf(request: unknown): Record<string, unknown> | undefined {
  const params = (request as { params?: { _meta?: unknown } }).params;
  const meta = params?._meta;
  return typeof meta === "object" && meta !== null
    ? (meta as Record<string, unknown>)
    : undefined;
}

/**
 * stellar-core-ts's {@link Call.decided} knows only `allow`, `would_deny` and
 * `would_consult`; Go's vocabulary also has `deny`, the decision an enforcing
 * PEP's refusal suffers (its record carries outcome `denied`). The library's
 * record vocabulary has no `deny` yet, so the record that left a refused call
 * (`outcome: denied`, the only thing that sets it is this PEP) is given the
 * decision here, on its way to the sink. Remove when the library carries it.
 */
export function withDenyDecision(sink: Sink): Sink {
  return (record: RequestRecord) =>
    sink(
      record.outcome === "denied" && record.decision === undefined
        ? { ...record, decision: "deny" as unknown as RecordedDecision }
        : record,
    );
}

/** The witness handler of stellar-core-ts, with the PEP's decision. */
export function pepHandler(
  log: RequestLog,
  pep: Pep,
  next: ToolCallHandler,
): ToolCallHandler {
  return async (request, extra) => {
    const name = request.params?.name;
    if (typeof name !== "string") return next(request, extra);
    const peer = peerFrom();
    const call = log.observe(name, { path: pathOf(peer) });
    call.caller(peer?.spiffeId, peer?.kind);
    try {
      const d = pep.adjudicate({
        peer,
        meta: metaOf(request),
        verb: name,
      });
      const refused = pep.refuses(d);
      record(call, pep, d, refused);
      if (refused) {
        return refusal(
          pep.star,
          name,
          peer?.spiffeId ?? "",
          consumerOf(peer),
          d,
        );
      }
      const result = (await next(request, extra)) as
        { isError?: unknown } | undefined;
      if (result?.isError === true) call.setOutcome("star_error");
      return result;
    } catch (err) {
      call.setOutcome("star_error");
      throw err;
    } finally {
      call.finish();
    }
  };
}

/** Put `d` on the call's record and count it. */
function record(
  call: ReturnType<RequestLog["observe"]>,
  pep: Pep,
  d: Decision,
  refused: boolean,
): void {
  const decision =
    pep.mode === "witness"
      ? WITNESS_DECISION[d.verdict]
      : d.verdict === "allow"
        ? "allow"
        : "deny";
  if (refused) call.denied(d.reason);
  call.decided(decision, d.reason);
  call.principal(d.principal, d.principalType); // "" for a service caller: omitted
  pep.count(decision, d.reason);
}

/**
 * The JSON-RPC method a request schema (or method name) stands for. The SDK's
 * schemas are zod objects whose `method` is a literal (zod 4: `.value`, zod 3:
 * `._def.value`); a bare method string is accepted. stellar-core-ts has this
 * but does not export it.
 */
function methodOf(schema: unknown): string | undefined {
  if (typeof schema === "string") return schema;
  const literal = (
    schema as {
      shape?: { method?: { value?: unknown; _def?: { value?: unknown } } };
    }
  ).shape?.method;
  const value = literal?.value ?? literal?._def?.value;
  return typeof value === "string" ? value : undefined;
}

/**
 * Decide and witness every `tools/call` the server dispatches, whenever and
 * however its handler is registered. Call on the MCP SDK's low-level server
 * BEFORE the first tool registers, in place of {@link witnessToolCalls}.
 */
export function pepToolCalls(
  server: HandlerRegistry,
  log: RequestLog,
  pep: Pep,
): void {
  const register = server.setRequestHandler.bind(server);
  server.setRequestHandler = (schema, handler) => {
    register(
      schema,
      (methodOf(schema) === "tools/call"
        ? pepHandler(log, pep, handler)
        : handler) as never,
    );
  };
}
