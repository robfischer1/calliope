import { describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial, opAdd, opCreate } from "../src/chaos-client.js";
import { writeContainer } from "../src/container-write.js";
import { TREE_CONTENT, readTree } from "../src/tree.js";
import {
  CENSUS_USAGE,
  censusDoubledSlots,
  runCensus,
} from "../scripts/census-doubled-slots-lib.js";

class Sink {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

async function container() {
  const dial = new FixtureChaosDial();
  const res = await dial.admit([opCreate("Note", "doc")], "notes");
  const doc = res.minted[0] ?? "";
  const facet = { blobs: new FixtureBlobStore(), dial };
  await writeContainer(facet, doc, [
    { op: "add", text: "a", position: "a0" },
    { op: "add", text: "b", position: "a1" },
  ]);
  const tree = await readTree(dial, doc);
  return { dial, doc, tree };
}

describe("census-doubled-slots", () => {
  it("finds only the slot holding two contents, ids in numeric order", async () => {
    const { dial, doc, tree } = await container();
    const second = tree[1];
    if (second?.blobId == null) throw new Error("bad setup");
    await dial.admit(
      [opAdd(second.slot, TREE_CONTENT, { toBlob: "9" })],
      "notes",
    );
    const found = await censusDoubledSlots(dial, [doc]);
    expect(found).toEqual([
      {
        container: doc,
        slot: second.slot,
        blobIds: [second.blobId, "9"].sort((a, b) => Number(a) - Number(b)),
      },
    ]);
  });

  it("reports nothing on a clean container and writes nothing", async () => {
    const { dial, doc } = await container();
    const before = dial.admits.length;
    expect(await censusDoubledSlots(dial, [doc])).toEqual([]);
    expect(dial.admits.length).toBe(before);
  });

  it("--help prints usage and exits 0; bad args exit 2; findings exit 1", async () => {
    const { dial, doc, tree } = await container();
    const out = new Sink();
    const err = new Sink();
    expect(await runCensus(["bun", "x", "--help"], dial, out, err)).toBe(0);
    expect(out.text).toBe(CENSUS_USAGE);
    expect(await runCensus(["bun", "x"], dial, out, err)).toBe(2);
    expect(await runCensus(["bun", "x", "nope"], dial, out, err)).toBe(2);
    expect(err.text).toContain("not a 64-hex container token: nope");
    expect(await runCensus(["bun", "x", doc], dial, out, err)).toBe(0);
    const first = tree[0];
    await dial.admit(
      [opAdd(first?.slot ?? "", TREE_CONTENT, { toBlob: "77" })],
      "notes",
    );
    const hit = new Sink();
    expect(await runCensus(["bun", "x", doc], dial, hit, err)).toBe(1);
    expect(hit.text).toBe(
      `${doc} ${first?.slot ?? ""} ${first?.blobId ?? ""},77\n`,
    );
  });
});
