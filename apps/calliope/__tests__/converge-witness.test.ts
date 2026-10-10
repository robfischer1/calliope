/**
 * The R-D15 converge witness (witness mode only): the shared aiws:converge
 * core runs beside notes-sink's reconcile and every difference is counted,
 * never acted on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixtureBodyClient } from "../src/fixture-client.js";
import {
  FixtureChaosDial,
  graphToken,
  opAdd,
  opCreate,
  opRemove,
} from "../src/chaos-client.js";
import { FixtureTagStore } from "../src/tag-store.js";
import { sinkNoteVersion } from "../src/notes-sink.js";
import {
  buildQuery,
  classify,
  type FactOp,
  factOps,
  type Observation,
  convergeMetrics,
  convergeMode,
  observe,
  resetConvergeMetrics,
} from "../src/converge-witness.js";

const SCOPE = "notes";

function rig() {
  return {
    client: new FixtureBodyClient(),
    dial: new FixtureChaosDial(),
    tags: new FixtureTagStore(),
  };
}

beforeEach(() => {
  resetConvergeMetrics();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NODE = "a".repeat(64);
const add = (p: string, o: string, node = false): FactOp => ({
  kind: "add",
  p,
  o,
  node,
});
const retract = (p: string, o: string, node = false): FactOp => ({
  kind: "retract",
  p,
  o,
  node,
});

function obs(over: Partial<Observation> = {}): Observation {
  return {
    name: "n",
    holders: [],
    scope: SCOPE,
    one: new Map(),
    additive: [],
    held: [],
    legacyOutcome: "created",
    legacyOps: [],
    ...over,
  };
}

/** A core receipt as the WIT hands it back. */
function receipt(
  outcome: "unchanged" | "created" | "updated" | "would-change",
  ops: {
    kind: "add" | "retract" | "relabel";
    p: string;
    o: string;
    node?: boolean;
  }[],
  verdict = "holds",
) {
  return {
    ok: {
      outcome,
      verdict,
      ops: ops.map((op) => ({ s: "n", g: SCOPE, node: false, ...op })),
      counts: { added: 0, removed: 0, relabeled: 0 },
      births: [],
      sideValues: [],
      unacked: [],
      author: "calliope",
    },
  } as unknown as Parameters<typeof classify>[1];
}

describe("factOps", () => {
  it("reduces edge ops and skips every other op", () => {
    expect(
      factOps([
        opCreate("Note", "n"),
        opAdd("n", "a", { toLiteral: "v" }),
        opRemove("n", "b", { toNode: NODE }),
        opRemove("n", "c", { toLiteral: "old" }),
        { op: "addEdge", from_id: "n", predicate: "d" },
      ]),
    ).toEqual([
      add("a", "v"),
      retract("b", NODE, true),
      retract("c", "old"),
      add("d", ""),
    ]);
  });
});

describe("buildQuery", () => {
  it("states the owned slots, the wanted facts and only the owned held facts", () => {
    const q = buildQuery(
      obs({
        holders: [NODE],
        one: new Map([["a", "1"]]),
        additive: [
          ["d", "x"],
          ["d", "y"],
          ["a", "z"],
        ],
        held: [
          { predicate: "a", value: "0", isNode: false },
          { predicate: "d", value: "x", isNode: false, graph: "" },
          {
            predicate: "d",
            value: NODE,
            isNode: true,
            graph: graphToken(SCOPE),
          },
          { predicate: "d", value: "w", isNode: false, graph: "elsewhere" },
          { predicate: "unowned", value: "q", isNode: false },
        ],
        legacyOutcome: "updated",
      }),
    );
    expect(q).toEqual({
      author: "calliope",
      dry: false,
      reach: { writeGraph: SCOPE, anyGraph: false, drainGraphs: [] },
      consent: "off",
      birthAck: "",
      acks: [],
      subjects: [
        { key: "n", holders: [NODE], heldLabel: "n", wantedLabel: "" },
      ],
      slots: [
        { s: "n", p: "a", mode: "one", ack: "" },
        { s: "n", p: "d", mode: "add-only", ack: "" },
      ],
      wanted: [
        { s: "n", p: "a", o: "1", g: SCOPE, node: false },
        { s: "n", p: "d", o: "x", g: SCOPE, node: false },
        { s: "n", p: "d", o: "y", g: SCOPE, node: false },
        { s: "n", p: "a", o: "z", g: SCOPE, node: false },
      ],
      held: [
        { s: "n", p: "a", o: "0", g: SCOPE, node: false },
        { s: "n", p: "d", o: "x", g: SCOPE, node: false },
        { s: "n", p: "d", o: NODE, g: SCOPE, node: true },
        { s: "n", p: "d", o: "w", g: "elsewhere", node: false },
      ],
      faults: [],
      lineage: [],
      heldLineage: [],
      bodies: [],
      cues: [],
    });
  });

  it("a mint names its wanted label and holds nothing", () => {
    const q = buildQuery(obs({ one: new Map([["a", "1"]]) }));
    expect(q.subjects).toEqual([
      { key: "n", holders: [], heldLabel: "", wantedLabel: "n" },
    ]);
    expect(q.held).toEqual([]);
  });
});

describe("classify", () => {
  it("a refusal from the core is the refusal case", () => {
    expect(classify(obs(), { err: { code: "conflict", detail: "d" } })).toEqual(
      {
        kase: "refusal",
        why: "core refused a write legacy made: conflict",
      },
    );
  });

  it("a verdict other than holds is an outcome disagreement", () => {
    expect(classify(obs(), receipt("would-change", [], "drifted"))).toEqual({
      kase: "outcome",
      why: "core's verdict is drifted, legacy wrote",
    });
  });

  it("agrees on the same outcome and ops, ignoring relabels", () => {
    expect(
      classify(
        obs({ legacyOps: [add("a", "1"), retract("b", NODE, true)] }),
        receipt("created", [
          { kind: "retract", p: "b", o: NODE, node: true },
          { kind: "relabel", p: "zzz", o: "ignored" },
          { kind: "add", p: "a", o: "1" },
        ]),
      ),
    ).toBeUndefined();
  });

  it("same outcome, different ops: the ops case, naming kinds and predicates only", () => {
    expect(
      classify(
        obs({ legacyOutcome: "updated", legacyOps: [add("a", "secret")] }),
        receipt("updated", [{ kind: "retract", p: "x", o: "secret2" }]),
      ),
    ).toEqual({
      kase: "ops",
      why: "legacy updated, core updated; differing ops [add a, retract x]",
    });
  });

  it("different outcome is the outcome case", () => {
    expect(
      classify(obs({ legacyOutcome: "unchanged" }), receipt("updated", [])),
    ).toEqual({
      kase: "outcome",
      why: "legacy unchanged, core updated; differing ops []",
    });
  });

  it("counts multiplicity and node form", () => {
    expect(
      classify(
        obs({ legacyOps: [add("a", "1"), add("a", "1")] }),
        receipt("created", [{ kind: "add", p: "a", o: "1" }]),
      )?.kase,
    ).toBe("ops");
    expect(
      classify(
        obs({ legacyOps: [add("a", "1", true)] }),
        receipt("created", [{ kind: "add", p: "a", o: "1" }]),
      )?.kase,
    ).toBe("ops");
    expect(
      classify(
        obs({ legacyOps: [add("a", "1")] }),
        receipt("created", [{ kind: "retract", p: "a", o: "1" }]),
      )?.kase,
    ).toBe("ops");
  });
});

describe("converge witness", () => {
  it("mode: witness by default, legacy only when asked, enforce runs as witness", () => {
    expect(convergeMode({})).toBe("witness");
    expect(convergeMode({ CALLIOPE_CONVERGE_MODE: "legacy" })).toBe("legacy");
    expect(convergeMode({ CALLIOPE_CONVERGE_MODE: "enforce" })).toBe("witness");
  });

  it("asks the core for a mint, an update and a no-op, and agrees with legacy each time", async () => {
    const { client, dial, tags } = rig();
    const input = { source_path: "W/n.md", body_text: "v1" };
    await sinkNoteVersion(client, dial, SCOPE, tags, input, undefined, {
      additiveAttrs: [["document_id", "d1"]],
    });
    await sinkNoteVersion(
      client,
      dial,
      SCOPE,
      tags,
      { ...input, body_text: "v2" },
      undefined,
      { additiveAttrs: [["document_id", "d1"]] },
    );
    await sinkNoteVersion(
      client,
      dial,
      SCOPE,
      tags,
      { ...input, body_text: "v2" },
      undefined,
      { additiveAttrs: [["document_id", "d1"]] },
    );
    const m = convergeMetrics();
    expect(m.calliope_converge_core_calls_total).toBe(3);
    expect(m.calliope_converge_core_faults_total).toBe(0);
    expect(m.calliope_converge_core_disagreements_outcome_total).toBe(0);
    expect(m.calliope_converge_core_disagreements_ops_total).toBe(0);
    expect(m.calliope_converge_core_disagreements_refusal_total).toBe(0);
    expect(m.calliope_converge_core_enforcing).toBe(0);
  });

  it("counts each real disagreement case against the real core, and logs it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // outcome: legacy wrote nothing where the held value is stale.
    observe(
      obs({
        holders: [NODE],
        one: new Map([["raw_hash", "h2"]]),
        held: [{ predicate: "raw_hash", value: "h1", isNode: false }],
        legacyOutcome: "unchanged",
      }),
    );
    // ops: same outcome, legacy sent an op the core did not.
    observe(
      obs({
        one: new Map([["a", "1"]]),
        legacyOps: [add("a", "1"), add("extra", "x")],
      }),
    );
    // refusal: two holders, which the core refuses as ambiguous.
    observe(
      obs({
        holders: [NODE, "b".repeat(64)],
        one: new Map([["a", "1"]]),
        legacyOutcome: "updated",
      }),
    );
    expect(convergeMetrics()).toEqual({
      calliope_converge_core_calls_total: 3,
      calliope_converge_core_faults_total: 0,
      calliope_converge_core_disagreements_outcome_total: 1,
      calliope_converge_core_disagreements_ops_total: 1,
      calliope_converge_core_disagreements_refusal_total: 1,
      calliope_converge_core_enforcing: 0,
    });
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      "converge witness: legacy and core disagree case=outcome why=legacy unchanged, core updated; differing ops [add raw_hash, retract raw_hash]",
      "converge witness: legacy and core disagree case=ops why=legacy created, core created; differing ops [add extra]",
      "converge witness: legacy and core disagree case=refusal why=core refused a write legacy made: ambiguous_identity",
    ]);
  });

  it("resetConvergeMetrics zeroes every counter", () => {
    observe(obs({ legacyOutcome: "unchanged" }));
    expect(convergeMetrics().calliope_converge_core_calls_total).toBe(1);
    resetConvergeMetrics();
    expect(Object.values(convergeMetrics()).every((v) => v === 0)).toBe(true);
  });

  it("legacy mode never calls the core", () => {
    observe(obs(), { CALLIOPE_CONVERGE_MODE: "legacy" });
    expect(convergeMetrics().calliope_converge_core_calls_total).toBe(0);
  });

  it("a query the core cannot take is one counted fault, the answer stands", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => {
      observe(obs({ name: "bad\ud800", one: new Map([["p", "v"]]) }));
    }).not.toThrow();
    const m = convergeMetrics();
    expect(m.calliope_converge_core_calls_total).toBe(1);
    expect(m.calliope_converge_core_faults_total).toBe(1);
    expect(m.calliope_converge_core_disagreements_outcome_total).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toMatch(
      /^converge witness: core did not answer; the legacy answer stands: ./,
    );
  });
});
