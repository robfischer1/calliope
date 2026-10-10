/**
 * The R-D15 converge witness (witness mode only): the shared aiws:converge
 * core runs beside notes-sink's reconcile and every difference is counted,
 * never acted on.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { FixtureTagStore } from "../src/tag-store.js";
import { sinkNoteVersion } from "../src/notes-sink.js";
import {
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

  it("counts a real disagreement and never throws", () => {
    observe({
      name: "x",
      holders: ["a".repeat(64)],
      scope: SCOPE,
      one: new Map([["raw_hash", "h2"]]),
      additive: [],
      held: [{ predicate: "raw_hash", value: "h1", isNode: false }],
      legacyOutcome: "unchanged",
      legacyOps: [],
    });
    const m = convergeMetrics();
    expect(m.calliope_converge_core_calls_total).toBe(1);
    expect(m.calliope_converge_core_disagreements_outcome_total).toBe(1);
  });

  it("legacy mode never calls the core", () => {
    observe(
      {
        name: "x",
        holders: [],
        scope: SCOPE,
        one: new Map(),
        additive: [],
        held: [],
        legacyOutcome: "unchanged",
        legacyOps: [],
      },
      { CALLIOPE_CONVERGE_MODE: "legacy" },
    );
    expect(convergeMetrics().calliope_converge_core_calls_total).toBe(0);
  });

  it("a malformed query is a counted fault, not a thrown error", () => {
    observe({
      name: "bad\ud800",
      holders: [],
      scope: SCOPE,
      one: new Map([["p", "v"]]),
      additive: [],
      held: [],
      legacyOutcome: "created",
      legacyOps: [],
    });
    const m = convergeMetrics();
    expect(m.calliope_converge_core_calls_total).toBe(1);
    expect(
      (m.calliope_converge_core_faults_total ?? 0) +
        (m.calliope_converge_core_disagreements_outcome_total ?? 0),
    ).toBeGreaterThan(0);
  });
});
