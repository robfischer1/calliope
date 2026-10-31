import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RestMount } from "@forge/stellar-core-ts/rest";
import { heartbeatOptions } from "../src/mcp/http.js";
import { recordingWitness, serveDoor } from "./rest-door.js";

/**
 * Drive the calliope star over a real socket, fixture-backed, the way every
 * caller reaches it since REST mesh P7 (rm39): its REST door, the only
 * listener. The tool surface is read from the served spec's `x-mcp-tools`
 * (the server's own tools/list, carried verbatim).
 */

let rest: RestMount;
let base: string;

interface ListedTool {
  name: string;
  title?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

/** The server's tools as the served spec carries them. */
async function listTools(at = base): Promise<ListedTool[]> {
  const doc = (await (await fetch(`${at}/openapi.json`)).json()) as {
    "x-mcp-tools"?: Record<string, ListedTool>;
  };
  return Object.values(doc["x-mcp-tools"] ?? {});
}

beforeEach(async () => {
  // Fixture backend: no urania connection, deterministic in-memory body model.
  ({ rest, base } = await serveDoor({ witness: recordingWitness().witness }));
});

afterEach(async () => {
  await rest.close();
});

describe("calliope-mcp HTTP star — fixture-backed over a real socket", () => {
  it("serves the full verb surface via tools/list — the F3 fence", async () => {
    // This list IS the caller-facing surface contract: every shipped verb
    // traces to a decided master-plan Exposes row, and nothing ships that
    // traces to none. Change it only alongside the plan that licenses it.
    const names = (await listTools()).map((t) => t.name).sort();
    expect(names).toEqual([
      "blob_census", // F7 — the inverted-census GC (mark-and-sweep)
      "container_history", // F5 — history IS the graph (as-of reads)
      "copy_reference",
      "create_note",
      "delete_note", // suppresses (default) or purges, so an import can be reversed
      "dissolve_note",
      "export_note",
      "file_revisions", // stays [Rob, F12] — frozen archive, read-only
      "list_by_tag",
      "list_tags",
      "look",
      "materialize_note",
      "move_blocks", // Threads: re-home slots between containers of one tenant
      "read_container", // F5 — the ordered tree read
      "read_containers", // the batch read: one call, not ~96
      "restore_note", // clears a suppression [Rob, 2026-10-06: delete = suppress]
      "revision_deltas", // stays [Rob, F12] — frozen archive, read-only
      "search", // Findability F2 — licensed by its Exposes row `search(query, scope)`
      "set_properties", // a note's frontmatter as graph edges
      "unpin",
      "write_container", // F4 — the ONE write path since the F12 cut
    ]);
  });

  it("every verb carries honest ToolAnnotations — the F10 map (B7's fence)", async () => {
    // The pinned map: readOnlyHint / destructiveHint / idempotentHint per
    // verb. A new verb without annotations fails here by construction.
    const MAP: Record<string, [boolean, boolean, boolean]> = {
      // reads
      read_container: [true, false, true],
      read_containers: [true, false, true],
      blob_census: [false, true, false], // F7 — the sweep reaps marked blobs

      container_history: [true, false, true],
      file_revisions: [true, false, true],
      revision_deltas: [true, false, true],
      list_by_tag: [true, false, true],
      list_tags: [true, false, true],
      export_note: [true, false, true],
      materialize_note: [true, false, true],
      copy_reference: [true, false, true],
      look: [true, false, true],
      search: [true, false, true], // Findability F2 — read-only, idempotent

      unpin: [false, true, true],
      // idempotent writes (no-op convergence tested in their own suites)
      create_note: [false, false, true],
      dissolve_note: [false, false, true],
      // replaces a named predicate's value set (and retract: removes), so
      // it can take a value away: destructive, and a re-run converges
      set_properties: [false, true, true],
      // suppresses (or, purge=true, retracts) a note; a re-run answers
      // already_suppressed / not_found, so it converges
      delete_note: [false, true, true],
      // retracts only the marker it finds; a re-run answers not_suppressed
      restore_note: [false, false, true],
      // the ONE write path (F4/F12): a save whose ops all net out writes
      // nothing, but the verb itself is not idempotent (adds mint slots).
      // Destructive: its remove op deletes a section (the dies classify it so)
      write_container: [false, true, false],
      // re-homes slots (retracts membership + position); not idempotent
      move_blocks: [false, true, false],
    };
    const tools = await listTools();
    expect(tools.length).toBe(Object.keys(MAP).length);
    for (const tool of tools) {
      const expected = MAP[tool.name];
      expect(expected, `unmapped verb ${tool.name}`).toBeDefined();
      if (!expected) continue;
      const a = tool.annotations;
      expect(a, `${tool.name} carries no annotations`).toBeDefined();
      expect(
        [
          a?.readOnlyHint ?? false,
          a?.destructiveHint ?? false,
          a?.idempotentHint ?? false,
        ],
        `${tool.name} hints`,
      ).toEqual(expected);
    }
  });

  it("serves no /mcp: the REST door is the only listener, probes beside it", async () => {
    expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/mcp`, { method: "GET" })).status).toBe(404);
    expect((await fetch(`${base}/live`)).status).toBe(200);
    expect((await fetch(`${base}/ready`)).status).toBe(200);
    expect((await fetch(`${base}/metrics`)).status).toBe(200);
  });
});

describe("heartbeatOptions — what this star hands the core's publisher", () => {
  it("beats under this star's own name", async () => {
    // The TOPIC is derived from this name (`calliope._ops.heartbeat`), and the
    // consciousness plane stamps the same constant. Two spellings of "who am
    // I" would be attributed to two stars, undetectably.
    const { SOURCE_STAR } = await import("../src/mcp/consciousness-emit.js");
    expect(heartbeatOptions().star).toBe(SOURCE_STAR);
    expect(heartbeatOptions().star).toBe("calliope");
  });

  it("reports ready, with the consciousness producer's own counters", async () => {
    const { consciousnessMetrics } =
      await import("../src/mcp/consciousness-emit.js");
    const { convergeMetrics } = await import("../src/converge-witness.js");
    const reading = heartbeatOptions().standing?.();
    expect(reading?.ready).toBe(true);
    expect(reading?.metrics).toEqual({
      ...consciousnessMetrics(),
      ...convergeMetrics(),
    });
    // Not an empty reading: `metrics` is what nyx renders on the star's card.
    expect(Object.keys(reading?.metrics ?? {})).toContain(
      "calliope_consciousness_published_total",
    );
  });

  it("reads the standing per beat, not once at boot", async () => {
    // A counter that moves between beats must be reported as it stands. A
    // reading captured at boot would freeze the star's gauges for the life of
    // the process, and a frozen gauge reads as a working one.
    const { ConsciousnessPublisher, resetConsciousnessMetrics } =
      await import("../src/mcp/consciousness-emit.js");
    const { FakeTransport } =
      await import("@forge/stellar-core-ts/kafkatopics");
    const { standing } = heartbeatOptions();

    resetConsciousnessMetrics();
    const before = standing?.();
    expect(before?.metrics.calliope_consciousness_publisher_wired).toBe(0);

    const publisher = new ConsciousnessPublisher(new FakeTransport());
    expect(publisher).toBeDefined();

    const after = standing?.();
    expect(after?.metrics.calliope_consciousness_publisher_wired).toBe(1);
  });
});

describe("the PRODUCTION boot shape (prebuilt client, F12 regression pin)", () => {
  it("serves the container surface when booted exactly as main() boots", async () => {
    // The live outage this pins (found on the deployed star, 2026-08-16):
    // main() passes a PREBUILT client with each facet as an option,
    // which SKIPS the make-the-backend-internally branch — so a facet
    // main() forgets to pass silently vanishes from the served surface
    // while the fixture-path test above stays green. Boot the server the
    // way main() does and pin the write path's presence.
    const { makeBackend } = await import("../src/mcp/backend.js");
    const { FocusRegister } = await import("../src/focus-register.js");
    const backend = makeBackend("fixture");
    const served = await serveDoor({
      witness: recordingWitness().witness,
      client: backend.client,
      revisions: backend.revisions,
      chaos: backend.chaos,
      tags: backend.tags,
      focus: new FocusRegister(),
      containers: backend.containers,
    });
    try {
      const names = (await listTools(served.base)).map((t) => t.name);
      expect(names).toContain("write_container");
      expect(names).toContain("read_container");
      expect(names).toContain("container_history");
    } finally {
      await served.rest.close();
    }
  });
});
