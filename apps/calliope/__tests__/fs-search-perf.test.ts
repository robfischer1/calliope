/**
 * Findability F14 — the search performance gate: Fable's stated budget,
 * "search p95 under 100 ms on a 10k-file fixture", asserted where the
 * engine lives. "If it runs like shit and feels sluggish, I'm going to
 * abandon it" makes this a constraint, not a polish pass.
 *
 * The fixture is deterministic (seeded LCG, wikilink-bearing lines —
 * grace's `packages/perf-fixtures` shapes, mirrored here pending a
 * published fixtures package; the constants match so the corpora agree).
 * The gate BLOCKS (it rides the ordinary suite), with the harness's
 * generous-first posture applied as margin: the budget catches the 10x
 * regression class — FTS5 answers this corpus in low single-digit ms, so
 * 100 ms is ~20x headroom, not a flake source.
 *
 * The semantic arm is deliberately absent here: CI provisions no encoder
 * assets, and the ruled brute-force scan is budgeted by design
 * (docs/search-architecture.md's measured MACs). The verb degrades
 * honestly to FTS — which is exactly what this measures.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSearchIndex } from "../src/fs-search/index.js";

const FILES = 10_000;
const P95_BUDGET_MS = 100;
const QUERIES = [
  "graph constellation",
  "renderer wikilink",
  "session verdict",
  "standing annotation",
  "fixture budget",
  "corpus journal",
  "anchor block",
  "surface curation",
  "constellation session",
  "wikilink anchor",
] as const;

/** The perf-fixtures LCG (Numerical Recipes constants), verbatim. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const WORDS = [
  "graph",
  "constellation",
  "renderer",
  "wikilink",
  "session",
  "verdict",
  "standing",
  "annotation",
  "fixture",
  "budget",
  "corpus",
  "journal",
  "anchor",
  "block",
  "surface",
  "curation",
] as const;

function fileBody(rand: () => number, index: number): string {
  const lines: string[] = [`# note ${String(index)}`];
  const paragraphs = 2 + Math.floor(rand() * 4);
  for (let p = 0; p < paragraphs; p++) {
    const words: string[] = [];
    for (let w = 0; w < 10 + Math.floor(rand() * 8); w++) {
      words.push(WORDS[Math.floor(rand() * WORDS.length)] ?? "graph");
    }
    if (rand() < 0.25) {
      words.push(`[[note-${String(Math.floor(rand() * FILES))}]]`);
    }
    lines.push("", words.join(" "));
  }
  return lines.join("\n");
}

let root = "";
let index: LocalSearchIndex | null = null;

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fs-search-perf-"));
  const rand = lcg(2_026);
  for (let i = 0; i < FILES; i++) {
    const dir = path.join(root, `d${String(i % 40)}`);
    if (i < 40) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `note-${String(i)}.md`), fileBody(rand, i));
  }
  index = LocalSearchIndex.open(root, { embedder: null, watch: false });
  await index.started; // the full catch-up index of all 10k files
}, 180_000);

afterAll(() => {
  index?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the search performance gate (F14)", () => {
  it(`p95 under ${String(P95_BUDGET_MS)}ms across ${String(QUERIES.length * 2)} queries on the 10k-file fixture`, async () => {
    const idx = index;
    expect(idx).not.toBeNull();
    if (idx === null) return;
    // Warm once (statement prep, page cache) — the budget is steady-state.
    await idx.search("graph");
    const samples: number[] = [];
    for (const q of [...QUERIES, ...QUERIES]) {
      const t0 = performance.now();
      const res = await idx.search(q);
      samples.push(performance.now() - t0);
      expect(res.armsQueried).toContain("fts");
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95) - 1] ?? 0;
    // Recorded for the CI log — the trend matters more than the pass.
    console.error(
      `fs-search perf: p95=${p95.toFixed(1)}ms median=${(samples[Math.floor(samples.length / 2)] ?? 0).toFixed(1)}ms over ${String(FILES)} files`,
    );
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  }, 60_000);
});
