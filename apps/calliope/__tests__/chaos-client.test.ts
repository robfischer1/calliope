import { describe, expect, it } from "vitest";
import {
  ANCHORS_ROLE,
  FixtureChaosDial,
  NOTE_ROOT_KIND,
  NOTE_ROOT_LABEL,
  ensureNotesRoot,
  isNodeToken,
  opAdd,
  opCreate,
} from "../src/chaos-client.js";

const SCOPE = "notes";

describe("op constructors — the court.py wire grammar, verbatim", () => {
  it("opCreate builds the mint op", () => {
    expect(opCreate("Note", "My Title")).toEqual({
      op: "createNode",
      kind: "Note",
      label: "My Title",
    });
  });

  it("opAdd builds literal and node edges", () => {
    expect(opAdd("aa", "hasName", { toLiteral: "x" })).toEqual({
      op: "addEdge",
      from_id: "aa",
      predicate: "hasName",
      to_literal: "x",
      to_node: null,
    });
    expect(opAdd("aa", "parent", { toNode: "bb" })).toEqual({
      op: "addEdge",
      from_id: "aa",
      predicate: "parent",
      to_literal: null,
      to_node: "bb",
    });
  });
});

describe("ensureNotesRoot", () => {
  it("mints the root on first ensure: createNode then hasName + anchorsRole", async () => {
    const dial = new FixtureChaosDial();
    const root = await ensureNotesRoot(dial, SCOPE, () => undefined);
    expect(isNodeToken(root)).toBe(true);
    expect(dial.admits).toHaveLength(2);
    const [mint, edges] = dial.admits;
    expect(mint?.ops).toEqual([opCreate(NOTE_ROOT_KIND, NOTE_ROOT_LABEL)]);
    expect(mint?.scope).toBe(SCOPE);
    expect(edges?.ops.map((o) => o.predicate)).toEqual([
      "hasName",
      ANCHORS_ROLE,
    ]);
  });

  it("returns the standing root without any admit", async () => {
    const dial = new FixtureChaosDial();
    const first = await ensureNotesRoot(dial, SCOPE, () => undefined);
    const before = dial.admits.length;
    const second = await ensureNotesRoot(dial, SCOPE, () => undefined);
    expect(second).toBe(first);
    expect(dial.admits.length).toBe(before);
  });

  it("a pre-existing root (seeded) is honored", async () => {
    const dial = new FixtureChaosDial();
    const token = "ab".repeat(32);
    dial.seed(NOTE_ROOT_KIND, NOTE_ROOT_LABEL, token);
    expect(await ensureNotesRoot(dial, SCOPE, () => undefined)).toBe(token);
    expect(dial.admits).toHaveLength(0);
  });

  it("a refused mint surfaces as admit_refused", async () => {
    const dial = new FixtureChaosDial();
    dial.refuseWith = [{ rule: "nope" }];
    await expect(
      ensureNotesRoot(dial, SCOPE, () => undefined),
    ).rejects.toThrowError(/mint refused/);
  });
});
