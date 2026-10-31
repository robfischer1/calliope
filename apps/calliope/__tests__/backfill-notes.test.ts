/**
 * The consciousness backfill CLI (absorb-arch-kiss): paging, --dry-run,
 * suppressed/empty skips, failure tally, pause between batches, and
 * idempotence against the REAL publisher (same node -> same compaction key).
 * Synthetic containers and a fake transport only; nothing leaves the process.
 */
import { describe, expect, it } from "vitest";
import type { Transport } from "@forge/stellar-core-ts/kafkatopics";

import {
  backfillNotes,
  DEFAULT_BATCH_SIZE,
  DEFAULT_PAUSE_MS,
  parseArgs,
  type NoteSource,
} from "../src/mcp/backfill-notes.js";
import {
  ConsciousnessPublisher,
  noteKey,
  type NoteProjection,
  type NotePublisher,
} from "../src/mcp/consciousness-emit.js";

const node = (n: number): string => n.toString(16).padStart(64, "0");

class FakePublisher implements NotePublisher {
  published: string[] = [];
  failOn = new Set<string>();
  publish(p: NoteProjection): Promise<boolean> {
    if (this.failOn.has(p.node)) return Promise.resolve(false);
    this.published.push(p.node);
    return Promise.resolve(true);
  }
  retract(): Promise<boolean> {
    return Promise.reject(new Error("backfill must never retract"));
  }
}

/** `count` synthetic containers; `empty`/`hidden`/`boom` mark special ones. */
function source(
  count: number,
  special: { empty?: number[]; hidden?: number[]; boom?: number[] } = {},
): NoteSource & { projected: string[] } {
  const ids = Array.from({ length: count }, (_, i) => node(i + 1));
  const pick = (xs: number[] = []): Set<string> =>
    new Set(xs.map((i) => node(i)));
  const empty = pick(special.empty);
  const boom = pick(special.boom);
  const projected: string[] = [];
  return {
    projected,
    list: () => Promise.resolve([...ids].reverse()),
    hidden: () => Promise.resolve(pick(special.hidden)),
    project: (n) => {
      projected.push(n);
      if (boom.has(n)) return Promise.reject(new Error("read boom"));
      if (empty.has(n)) return Promise.resolve(undefined);
      return Promise.resolve({ node: n, body: `synthetic ${n.slice(-4)}` });
    },
  };
}

describe("parseArgs", () => {
  it("defaults, and reads every flag", () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      batchSize: DEFAULT_BATCH_SIZE,
      pauseMs: DEFAULT_PAUSE_MS,
    });
    expect(
      parseArgs(["--dry-run", "--batch-size", "5", "--pause-ms", "0"]),
    ).toEqual({ dryRun: true, batchSize: 5, pauseMs: 0 });
  });

  it("refuses unknown flags and bad numbers instead of ignoring them", () => {
    expect(() => parseArgs(["--probe"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--batch-size", "0"])).toThrow(/>= 1/);
    expect(() => parseArgs(["--batch-size"])).toThrow(/>= 1/);
    expect(() => parseArgs(["--pause-ms", "-1"])).toThrow(/>= 0/);
    expect(() => parseArgs(["--pause-ms", "1.5"])).toThrow(/>= 0/);
  });
});

describe("backfillNotes", () => {
  it("publishes every container in sorted order and summarises", async () => {
    const pub = new FakePublisher();
    const res = await backfillNotes(source(5), pub, {
      batchSize: 2,
      pauseMs: 0,
    });
    expect(res).toEqual({
      dryRun: false,
      containers: 5,
      suppressed: 0,
      empty: 0,
      published: 5,
      failed: 0,
      batches: 3,
    });
    expect(pub.published).toEqual([1, 2, 3, 4, 5].map(node));
  });

  it("--dry-run counts only: no projection, no publisher needed", async () => {
    const src = source(4, { hidden: [2] });
    const res = await backfillNotes(src, undefined, { dryRun: true });
    expect(res).toMatchObject({
      dryRun: true,
      containers: 4,
      suppressed: 1,
      published: 0,
      batches: 0,
    });
    expect(src.projected).toEqual([]);
  });

  it("a live run without a publisher is refused, not silently a no-op", async () => {
    await expect(backfillNotes(source(1), undefined)).rejects.toThrow(
      /no publisher/,
    );
  });

  it("skips suppressed and prose-less containers and never retracts", async () => {
    const pub = new FakePublisher();
    const src = source(4, { hidden: [1], empty: [2] });
    const res = await backfillNotes(src, pub, { pauseMs: 0 });
    expect(res).toMatchObject({ suppressed: 1, empty: 1, published: 2 });
    expect(src.projected).not.toContain(node(1));
  });

  it("tallies a refused publish and a projection error, and continues", async () => {
    const pub = new FakePublisher();
    pub.failOn.add(node(1));
    const res = await backfillNotes(source(4, { boom: [3] }), pub, {
      pauseMs: 0,
    });
    expect(res).toMatchObject({ published: 2, failed: 2 });
    expect(pub.published).toEqual([node(2), node(4)]);
  });

  it("pauses between batches, not before the first or after the last", async () => {
    const sleeps: number[] = [];
    await backfillNotes(source(5), new FakePublisher(), {
      batchSize: 2,
      pauseMs: 250,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(sleeps).toEqual([250, 250]);
  });

  it("is idempotent on the wire: a second run re-sends the same keys", async () => {
    const sent: { key: string; value: string | null }[] = [];
    const transport: Transport = {
      produce: (_t, key, value) => {
        sent.push({ key: key ?? "", value });
      },
    };
    const pub = new ConsciousnessPublisher(transport, {
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const opts = { pauseMs: 0 };
    await backfillNotes(source(3), pub, opts);
    await backfillNotes(source(3), pub, opts);
    expect(sent).toHaveLength(6);
    expect(sent.slice(0, 3)).toEqual(sent.slice(3));
    expect(sent.slice(0, 3).map((s) => s.key)).toEqual(
      [1, 2, 3].map((i) => noteKey(node(i))),
    );
    expect(new Set(sent.map((s) => s.key)).size).toBe(3);
  });
});
