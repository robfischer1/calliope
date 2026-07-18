/**
 * C7 `read_plan` — the by-reference projection read over the document store.
 * Fixture-backed (the store contract the wire drives), proving handle
 * resolution, the whole-plan block index, single-block addressing, and misses.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { FixtureDocumentStore } from "../src/document-store.js";
import { isReadPlanError, readPlan } from "../src/mcp/plan-ingest.js";

const PLAN_BODY = `# A plan

# Feature list

### C6 — The vault carve  ·  L
- Brief: finish the dissolution.

### C7 — The plan-ingest surface  ·  M
- Brief: block-addressable read.
`;

let store: FixtureDocumentStore;
let planId: number;

beforeEach(async () => {
  store = new FixtureDocumentStore();
  const res = await store.write({
    source_path: "System/Pantheon/WBS/Calliope — Master-plan.md",
    body_text: PLAN_BODY,
    schema_type: "Plan",
    subject: "Calliope — Master-plan",
  });
  planId = res.id ?? 0;
});

describe("read_plan — whole-plan (by reference)", () => {
  it("resolves by document id and returns the block index + body", async () => {
    const r = await readPlan(store, { document: planId });
    expect(isReadPlanError(r)).toBe(false);
    if (isReadPlanError(r) || "block" in r) throw new Error("want whole-plan");
    expect(r.handle.document).toBe(planId);
    expect(r.block_count).toBe(2);
    expect(r.blocks.map((b) => b.id)).toEqual(["C6", "C7"]);
    expect(r.body_text).toBe(PLAN_BODY);
  });

  it("resolves by source_path (newest version wins)", async () => {
    const r = await readPlan(store, {
      source_path: "System/Pantheon/WBS/Calliope — Master-plan.md",
    });
    if (isReadPlanError(r) || "block" in r) throw new Error("want whole-plan");
    expect(r.handle.document).toBe(planId);
    expect(r.block_count).toBe(2);
  });

  it("omit_body drops the prose but keeps the block index", async () => {
    const r = await readPlan(store, { document: planId, omit_body: true });
    if (isReadPlanError(r) || "block" in r) throw new Error("want whole-plan");
    expect(r.body_text).toBeUndefined();
    expect(r.blocks).toHaveLength(2);
  });
});

describe("read_plan — single block (block-addressable)", () => {
  it("serves one feature block by id and echoes the block ref", async () => {
    const r = await readPlan(store, { document: planId, block: "C7" });
    if (isReadPlanError(r) || !("block" in r)) throw new Error("want block");
    expect(r.handle.block).toBe("C7");
    expect(r.block.id).toBe("C7");
    expect(r.block.size).toBe("M");
    expect(r.block.text).toContain("block-addressable read");
    expect(r.block.text).not.toContain("C6 —");
  });
});

describe("read_plan — structured misses", () => {
  it("bad_handle when neither document nor source_path is given", async () => {
    const r = await readPlan(store, {});
    expect(isReadPlanError(r) && r.error).toBe("bad_handle");
  });

  it("document_not_found for an unknown id", async () => {
    const r = await readPlan(store, { document: 99999 });
    expect(isReadPlanError(r) && r.error).toBe("document_not_found");
  });

  it("block_not_found for an unknown block id", async () => {
    const r = await readPlan(store, { document: planId, block: "Z9" });
    expect(isReadPlanError(r) && r.error).toBe("block_not_found");
  });
});
