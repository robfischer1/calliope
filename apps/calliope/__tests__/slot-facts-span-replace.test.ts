/**
 * A segment's turn window is single-valued: an update carrying a new one
 * replaces the held one (scotty43-003). Before this a second write left two
 * spanFrom literals on the slot, and glaucus's backfill could not correct a
 * wrong window (thread 421: every later checkpoint of a session read
 * `a..a-1` because the first one's window had swallowed the session).
 */

import { describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial, opCreate } from "../src/chaos-client.js";
import { readContainer } from "../src/container-read.js";
import { writeContainer } from "../src/container-write.js";
import { readTree } from "../src/tree.js";

async function seeded(facts: { predicate: string; literal: string }[]) {
  const dial = new FixtureChaosDial();
  const facet = { blobs: new FixtureBlobStore(), dial };
  const r = await dial.admit([opCreate("Note", "t")], "threads");
  const c = r.minted[0] ?? "";
  await writeContainer(facet, c, [
    { op: "add", text: "v1", position: "a0", facts },
  ]);
  const [slot] = await readTree(dial, c);
  if (slot?.blobId == null) throw new Error("no slot");
  const held = slot.blobId;
  const update = (next: { predicate: string; literal: string }[]) =>
    writeContainer(facet, c, [
      {
        op: "update",
        slot: slot.slot,
        oldBlobId: held,
        text: "v1",
        facts: next,
      },
    ]);
  const facts_ = async () =>
    (await readContainer(facet, c, { facts: true })).blocks[0]?.facts;
  return { update, facts: facts_ };
}

const span = (from: string, to: string, digest?: string) => [
  { predicate: "spanFrom", literal: from },
  { predicate: "spanTo", literal: to },
  ...(digest === undefined
    ? []
    : [{ predicate: "turnsDigest", literal: digest }]),
];

describe("rewriting a segment's turn window", () => {
  it("replaces the held window instead of adding a second one", async () => {
    const s = await seeded(span("0", "1116", "aaaaaaaaaaaaaaaa"));
    await s.update(span("0", "267", "bbbbbbbbbbbbbbbb"));
    expect(await s.facts()).toEqual([
      { predicate: "spanFrom", form: "literal", value: "0" },
      { predicate: "spanTo", form: "literal", value: "267" },
      { predicate: "turnsDigest", form: "literal", value: "bbbbbbbbbbbbbbbb" },
    ]);
  });

  it("drops the held digest when the new window is empty", async () => {
    const s = await seeded(span("0", "9", "aaaaaaaaaaaaaaaa"));
    await s.update(span("10", "9"));
    expect(await s.facts()).toEqual([
      { predicate: "spanFrom", form: "literal", value: "10" },
      { predicate: "spanTo", form: "literal", value: "9" },
    ]);
  });

  it("is a no-op when the same window is written again", async () => {
    const s = await seeded(span("3", "7", "cccccccccccccccc"));
    const r = await s.update(span("3", "7", "cccccccccccccccc"));
    expect(r.noop).toBe(true);
    expect(await s.facts()).toEqual([
      { predicate: "spanFrom", form: "literal", value: "3" },
      { predicate: "spanTo", form: "literal", value: "7" },
      { predicate: "turnsDigest", form: "literal", value: "cccccccccccccccc" },
    ]);
  });

  it("leaves the window alone when an update carries no span", async () => {
    const s = await seeded(span("3", "7", "cccccccccccccccc"));
    await s.update([{ predicate: "links", literal: "a.md" }]);
    expect(await s.facts()).toEqual([
      { predicate: "links", form: "literal", value: "a.md" },
      { predicate: "spanFrom", form: "literal", value: "3" },
      { predicate: "spanTo", form: "literal", value: "7" },
      { predicate: "turnsDigest", form: "literal", value: "cccccccccccccccc" },
    ]);
  });
});
