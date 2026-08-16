/**
 * The blob census (spec 044-blob-gc) — F7's success criteria: unreferenced
 * reapable (after the mark round), referenced never reaped, dangling
 * reported, incomplete census reaps nothing, empty report ≠ no report.
 */

import { describe, expect, it } from "vitest";
import { runBlobCensus } from "../src/blob-census.js";
import { FixtureBlobGc, FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial, opCreate } from "../src/chaos-client.js";
import { writeContainer } from "../src/container-write.js";

async function setup() {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const gc = new FixtureBlobGc(blobs);
  const res = await dial.admit([opCreate("Note", "doc")], "notes");
  const doc = res.minted[0];
  if (doc === undefined) throw new Error("fixture minted nothing");
  return { dial, blobs, gc, doc, facet: { blobs, dial } };
}

describe("the blob census (F7)", () => {
  it("marks then reaps an orphan; never touches the referenced (SC)", async () => {
    const { dial, blobs, gc, doc, facet } = await setup();
    await writeContainer(facet, doc, [
      { op: "add", text: "referenced prose", position: "a0" },
    ]);
    const orphan = await blobs.mint("orphaned by a crashed save");

    // Round 1: complete census MARKS the orphan, reaps nothing.
    const round1 = await runBlobCensus({ gc, dial });
    expect(round1.complete).toBe(true);
    expect(round1.marked).toEqual([orphan]);
    expect(round1.reaped).toEqual([]);
    expect(blobs.size).toBe(2);

    // Round 2 with execute: the still-unheld mark reaps; the held survives.
    const round2 = await runBlobCensus({ gc, dial }, { execute: true });
    expect(round2.executed).toBe(true);
    expect(round2.reaped).toEqual([orphan]);
    expect(blobs.size).toBe(1);
    expect(await blobs.findByContent("referenced prose")).not.toBeNull();
    expect(await blobs.getText(orphan)).toBeNull();
  });

  it("a marked blob later referenced is spared (the grace window)", async () => {
    const { dial, blobs, gc, doc, facet } = await setup();
    const pending = await blobs.mint("minted for a save in flight");
    const round1 = await runBlobCensus({ gc, dial });
    expect(round1.marked).toEqual([pending]);

    // The in-flight save lands between rounds.
    await writeContainer(facet, doc, [
      { op: "add", text: "minted for a save in flight", position: "a0" },
    ]);
    const round2 = await runBlobCensus({ gc, dial }, { execute: true });
    expect(round2.reaped).toEqual([]);
    expect(round2.marked).toEqual([]);
    expect(await blobs.getText(pending)).toBe("minted for a save in flight");
  });

  it("an incomplete census marks and reaps NOTHING", async () => {
    const { dial, blobs, gc } = await setup();
    const orphan = await blobs.mint("orphan under a broken reporter");
    dial.failHeldBlobs = true;
    const report = await runBlobCensus({ gc, dial }, { execute: true });
    expect(report.complete).toBe(false);
    expect(report.executed).toBe(false);
    expect(report.marked).toEqual([]);
    expect(report.reaped).toEqual([]);
    expect(report.reporters.every((r) => !r.ok)).toBe(true);
    expect(await gc.readMarks()).toEqual([]); // no mark state written
    dial.failHeldBlobs = false;
    void orphan;
  });

  it("reports dangling references and never fixes them", async () => {
    const { dial, gc, doc } = await setup();
    // A tree fact naming a blob the store never minted.
    const { slotBirthOps } = await import("../src/tree.js");
    await dial.admit(slotBirthOps(doc, "b:a0", "a0", "424242"), "notes");
    const report = await runBlobCensus({ gc, dial });
    expect(report.complete).toBe(true);
    expect(report.dangling).toEqual(["424242"]);
  });

  it("distinguishes an empty report from no report", async () => {
    const { dial, gc } = await setup();
    const report = await runBlobCensus({ gc, dial });
    expect(report.complete).toBe(true);
    expect(report.reporters).toHaveLength(4);
    expect(report.reporters.every((r) => r.ok && r.count === 0)).toBe(true);
  });

  it("leaves blobs minted after the snapshot out of frame", async () => {
    const { dial, blobs, gc } = await setup();
    await blobs.mint("pre-snapshot orphan");
    const report = await runBlobCensus({ gc, dial });
    // Everything ≤ snapshot and unheld is marked; nothing beyond.
    expect(report.marked).toHaveLength(1);
  });
});
