/**
 * Fractional keys must not grow without bound under repeated appends.
 *
 * Measured live (governance-blocks container): appending past "9" minted
 * 9, 95, 955, 9555, 95555 — one digit per append. keyAbove now steps the
 * remainder, and a write that would mint a key longer than MAX_KEY_LEN
 * re-lays the container with sequence() in the same admit.
 */
import { describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial, opCreate } from "../src/chaos-client.js";
import { moveBlocks } from "../src/container-move.js";
import { writeContainer } from "../src/container-write.js";
import { containerBodies } from "../src/container-body.js";
import { readContainer } from "../src/container-read.js";
import { between, compareKeys, mintRun } from "../src/order-key.js";

const HEX = "ab".repeat(32);

describe("keyAbove", () => {
  it("steps the remainder past the ceiling instead of growing a digit", () => {
    expect(between("9", null)).toBe("95");
    expect(between("95", null)).toBe("96");
    expect(between("99", null)).toBe("995");
  });
});

describe("mintRun", () => {
  it("refuses a run that outgrows the cap, and a gap below the floor", () => {
    expect(mintRun("9999", null, 1)).toBeNull();
    expect(mintRun(null, "0", 1)).toBeNull();
    expect(mintRun("01", null, 3)).toEqual(["1", "2", "3"]);
  });
});

describe("append through the write path", () => {
  // 4 = the key-length cap (MAX_KEY_LEN): sequence() keys are 2 chars here.
  it("keeps key length bounded and order preserved over 50 one-block appends", async () => {
    const dial = new FixtureChaosDial();
    const blobs = new FixtureBlobStore();
    const facet = { dial, blobs };
    const bodies = containerBodies(facet);
    const texts: string[] = [];
    let longest = 0;
    for (let i = 0; i < 50; i++) {
      texts.push(`block ${String(i)}`);
      await bodies.saveBody(
        HEX,
        texts.map((text) => ({ text })),
      );
      const { blocks } = await readContainer(facet, HEX);
      expect(blocks.map((b) => b.text)).toEqual(texts);
      const keys = blocks.map((b) => b.position);
      for (let k = 1; k < keys.length; k++) {
        expect(compareKeys(keys[k - 1] ?? "", keys[k] ?? "")).toBe(-1);
      }
      longest = Math.max(longest, ...keys.map((k) => k.length));
    }
    expect(longest).toBeLessThanOrEqual(4);
  });
});

describe("move_blocks to the end of a destination", () => {
  it("keeps destination keys bounded over 30 single-block moves", async () => {
    const dial = new FixtureChaosDial();
    const blobs = new FixtureBlobStore();
    const facet = { dial, blobs };
    const mint = async (label: string): Promise<string> =>
      (await dial.admit([opCreate("Note", label)], "notes")).minted[0] ?? "";
    const from = await mint("src");
    const to = await mint("dst");
    const total = 30;
    await writeContainer(
      facet,
      from,
      Array.from({ length: total }, (_, i) => ({
        op: "add" as const,
        text: `m${String(i)}`,
        position: String(i + 1).padStart(2, "0"),
      })),
    );
    const order = (await readContainer(facet, from)).blocks;
    for (const b of order) {
      await moveBlocks(facet, { from, to, slots: [b.slot] });
      const dest = (await readContainer(facet, to)).blocks;
      const keys = dest.map((d) => d.position);
      expect(keys.every((k) => k.length <= 4)).toBe(true);
      for (let k = 1; k < keys.length; k++) {
        expect(compareKeys(keys[k - 1] ?? "", keys[k] ?? "")).toBe(-1);
      }
    }
    const dest = (await readContainer(facet, to)).blocks;
    expect(dest.map((d) => d.text)).toEqual(order.map((b) => b.text));
  });
});
