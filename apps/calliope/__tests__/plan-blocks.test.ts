/**
 * C7 block-addressing scheme — the pure parser. Proves the feature-head grammar
 * (the conventions in the wild), block extent, size/title split, and slicing.
 */

import { describe, expect, it } from "vitest";
import {
  parsePlanBlocks,
  sliceBlock,
  toBlockRef,
  type PlanBlock,
} from "../src/plan-blocks.js";

/** Index a block, narrowing away `undefined` (strict noUncheckedIndexedAccess). */
function at(blocks: PlanBlock[], i: number): PlanBlock {
  const b = blocks[i];
  if (b === undefined) throw new Error(`no block at index ${String(i)}`);
  return b;
}

/** A plan body in the shape athena projects — the Calliope master-plan grammar. */
const PLAN = `# Calliope — Master-plan

## Objective
Some framing prose before any feature block.

# Feature list — amend increment

### C6 — The vault carve: Calliope eats all the markdown  ·  L
- **Brief:** Finish the vault→Calliope dissolution.
- **Success:** a bulk dissolve sweeps the dissolvable pillars.

#### C6 sub-note
This deeper heading stays inside C6.

### C7 — The plan-ingest surface (athena by-reference projection)  ·  M
- **Brief:** Give Calliope a projection-shaped ingest read.
- **Success:** block-granular reads verified.

## Cross-feature DAG
C6 ──► C7
`;

describe("parsePlanBlocks — the block-addressing scheme", () => {
  it("addresses each feature block by its id token, in document order", () => {
    const blocks = parsePlanBlocks(PLAN);
    expect(blocks.map((b) => b.id)).toEqual(["C6", "C7"]);
    expect(blocks.map((b) => b.order)).toEqual([0, 1]);
  });

  it("splits the heading into title + size", () => {
    const blocks = parsePlanBlocks(PLAN);
    const c6 = at(blocks, 0);
    const c7 = at(blocks, 1);
    expect(c6.title).toBe("The vault carve: Calliope eats all the markdown");
    expect(c6.size).toBe("L");
    expect(c7.title).toBe(
      "The plan-ingest surface (athena by-reference projection)",
    );
    expect(c7.size).toBe("M");
  });

  it("excludes the preamble before the first feature block", () => {
    const c6 = at(parsePlanBlocks(PLAN), 0);
    expect(c6.text.startsWith("### C6 —")).toBe(true);
    expect(c6.text).not.toContain("Objective");
  });

  it("keeps a deeper sub-heading inside its block", () => {
    const c6 = at(parsePlanBlocks(PLAN), 0);
    expect(c6.text).toContain("#### C6 sub-note");
    expect(c6.text).toContain("stays inside C6");
    // ...but not the next sibling feature.
    expect(c6.text).not.toContain("C7 —");
  });

  it("ends the last block at a higher-level section boundary", () => {
    const c7 = at(parsePlanBlocks(PLAN), 1);
    expect(c7.text).toContain("block-granular reads verified");
    expect(c7.text).not.toContain("Cross-feature DAG");
  });

  it("accepts the conventions in the wild (## / #### / the Feature word)", () => {
    const wild = [
      "## H1 — Handle + tines  ·  L",
      "body h1",
      "### Feature H2 — The word Feature  ·  S",
      "body h2",
      "#### E1 — Star-initial prefix  ·  XL",
      "body e1",
    ].join("\n");
    const blocks = parsePlanBlocks(wild);
    expect(blocks.map((b) => b.id)).toEqual(["H1", "H2", "E1"]);
    expect(blocks.map((b) => b.size)).toEqual(["L", "S", "XL"]);
    expect(blocks.map((b) => b.level)).toEqual([2, 3, 4]);
  });

  it("returns [] for a prose-only body (no feature-shaped headings)", () => {
    expect(parsePlanBlocks("# Notes\n\nJust prose, no features.\n")).toEqual(
      [],
    );
  });

  it("leaves size null when the trailing token is not a size", () => {
    const b = at(parsePlanBlocks("### C9 — A title · not-a-size\nbody"), 0);
    expect(b.title).toBe("A title · not-a-size");
    expect(b.size).toBeNull();
  });
});

describe("sliceBlock — single-block addressing", () => {
  it("slices a block by id, case-insensitively", () => {
    const upper = sliceBlock(PLAN, "C7");
    const lower = sliceBlock(PLAN, "c7");
    expect(upper?.id).toBe("C7");
    expect(lower?.id).toBe("C7");
    expect(upper?.text).toBe(lower?.text);
  });

  it("returns null for an unknown block id", () => {
    expect(sliceBlock(PLAN, "Z9")).toBeNull();
  });
});

describe("toBlockRef — the index entry (address, not bytes)", () => {
  it("projects id/title/size/order and drops the prose", () => {
    const c6 = at(parsePlanBlocks(PLAN), 0);
    const ref = toBlockRef(c6);
    expect(ref).toEqual({
      id: "C6",
      title: "The vault carve: Calliope eats all the markdown",
      size: "L",
      order: 0,
    });
    expect(ref).not.toHaveProperty("text");
  });
});
