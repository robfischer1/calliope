/**
 * A note is a container of one block by default: given the blob store,
 * create_note births that block, empty, in the same admit as the note, so a
 * new note is never readable with nowhere to type. A reused note gains no
 * block, and without a blob store nothing changes.
 */
import { describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { readContainer } from "../src/container-read.js";
import {
  BORN_BLOCK_POSITION,
  createNote,
  isCreateNoteError,
} from "../src/mcp/tools.js";

const SCOPE = "notes";

describe("create_note births one block", () => {
  it("a new note holds one empty block at a0, minted in the note's own admit", async () => {
    const dial = new FixtureChaosDial();
    const blobs = new FixtureBlobStore();
    const res = await createNote(
      dial,
      SCOPE,
      { title: "Fresh" },
      undefined,
      blobs,
    );
    if (isCreateNoteError(res)) throw new Error(res.detail);
    expect(res.created).toBe(true);
    const admitsBefore = dial.admits.length;
    const { blocks } = await readContainer({ blobs, dial }, res.node_id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("");
    expect(blocks[0]?.position).toBe(BORN_BLOCK_POSITION);
    expect(blocks[0]?.dangling).toBe(false);
    const mintAdmit = dial.admits.find((a) =>
      a.ops.some((o) => o.op === "createNode" && o.label === "Fresh"),
    );
    expect(
      mintAdmit?.ops.filter((o) => o.op === "createNode").map((o) => o.kind),
    ).toEqual(["Note", "Block"]);
    expect(dial.admits.length).toBe(admitsBefore);
  });

  it("a reused note gains no second block", async () => {
    const dial = new FixtureChaosDial();
    const blobs = new FixtureBlobStore();
    const first = await createNote(
      dial,
      SCOPE,
      { title: "Again" },
      undefined,
      blobs,
    );
    const again = await createNote(
      dial,
      SCOPE,
      { title: "Again" },
      undefined,
      blobs,
    );
    if (isCreateNoteError(first) || isCreateNoteError(again)) {
      throw new Error("refused");
    }
    expect(again).toMatchObject({ node_id: first.node_id, created: false });
    const { blocks } = await readContainer({ blobs, dial }, first.node_id);
    expect(blocks).toHaveLength(1);
  });

  it("without a blob store the mint is the note alone", async () => {
    const dial = new FixtureChaosDial();
    const blobs = new FixtureBlobStore();
    const res = await createNote(dial, SCOPE, { title: "Bare" });
    if (isCreateNoteError(res)) throw new Error(res.detail);
    const { blocks } = await readContainer({ blobs, dial }, res.node_id);
    expect(blocks).toEqual([]);
  });
});
