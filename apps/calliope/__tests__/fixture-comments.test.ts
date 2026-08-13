/**
 * F4 (026) — comments as blocks with a commentsOn edge: the fixture twin.
 *
 * A comment is an ordinary block in the derived comment container plus one
 * edge; creation is atomic and REQUIRES a session-principal author (TURN
 * 258: sessions comment with identity). Threads follow the target's
 * lineage so an edit never orphans its review trail, and the document's
 * own body reads are untouched by any amount of commentary.
 */

import { describe, expect, it } from "vitest";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { commentContainerOf } from "../src/types.js";

const PRINCIPAL =
  "spiffe://notusmi.com/session/aa579121-1a2b-4c3d-8e4f-a5b6c7d8e9f0";
const OTHER =
  "spiffe://notusmi.com/session/bb579121-1a2b-4c3d-8e4f-a5b6c7d8e9f0";

async function seedOneBlock(
  client: FixtureBodyClient,
  container: string,
  text: string,
): Promise<string> {
  const result = await client.applySectionOps(container, [
    { op: "add", text, orderKey: "a0" },
  ]);
  const added = result.applied.at(0);
  if (!added) throw new Error("seed failed");
  return added.id;
}

describe("commentContainerOf", () => {
  it("derives and is idempotent on the suffix", () => {
    expect(commentContainerOf("abc")).toBe("abc#comments");
    expect(commentContainerOf("abc#comments")).toBe("abc#comments");
  });
});

describe("FixtureBodyClient — 026 comments", () => {
  it("creates a comment: block + edge, attributed, read back both ways", async () => {
    const client = new FixtureBodyClient();
    const target = await seedOneBlock(client, "doc1", "the target block");

    const made = await client.createComment(
      "doc1",
      target,
      "this drifted",
      PRINCIPAL,
      42,
    );
    expect(made.targetId).toBe(target);
    expect(made.commentContainerId).toBe("doc1#comments");

    const threads = await client.listComments("doc1", target);
    expect(threads).toHaveLength(1);
    const thread = threads[0];
    if (!thread) throw new Error("no thread");
    expect(thread.targetId).toBe(target);
    expect(thread.targetState).toBe("active");
    expect(thread.comments).toHaveLength(1);
    const c = thread.comments[0];
    if (!c) throw new Error("no comment");
    expect(c.text).toBe("this drifted");
    expect(c.author).toBe(PRINCIPAL);
    expect(c.kafkaOffset).toBe(42);
    expect(c.commentsOn).toBe(target);

    // The other direction: every thread in the container.
    const all = await client.listComments("doc1");
    expect(all.map((t) => t.targetId)).toEqual([target]);
  });

  it("rejects an unattributed or legacy-authored comment — nothing lands", async () => {
    const client = new FixtureBodyClient();
    const target = await seedOneBlock(client, "doc2", "block");

    await expect(
      client.createComment("doc2", target, "anon", "human", undefined),
    ).rejects.toThrow(/session/);
    expect(await client.listComments("doc2")).toEqual([]);
    // The comment container gained no block either (atomicity).
    expect(await client.readBody(commentContainerOf("doc2"))).toEqual([]);
  });

  it("rejects a stale target — nothing lands", async () => {
    const client = new FixtureBodyClient();
    await seedOneBlock(client, "doc3", "block");
    await expect(
      client.createComment("doc3", "no-such-block", "x", PRINCIPAL),
    ).rejects.toThrow(/stale/);
    expect(await client.readBody(commentContainerOf("doc3"))).toEqual([]);
  });

  it("a reply is a comment on a comment and threads as a chain", async () => {
    const client = new FixtureBodyClient();
    const target = await seedOneBlock(client, "doc4", "block");
    const parent = await client.createComment(
      "doc4",
      target,
      "first observation",
      PRINCIPAL,
    );
    const reply = await client.createComment(
      "doc4",
      parent.comment.id,
      "seconded",
      OTHER,
    );
    expect(reply.commentContainerId).toBe("doc4#comments");

    const parentThread = await client.listComments("doc4", parent.comment.id);
    expect(parentThread[0]?.comments.map((c) => c.text)).toEqual(["seconded"]);
    const all = await client.listComments("doc4");
    expect(all.map((t) => t.targetId).sort()).toEqual(
      [target, parent.comment.id].sort(),
    );
  });

  it("an edited target keeps its thread — resolution follows the lineage", async () => {
    const client = new FixtureBodyClient();
    const target = await seedOneBlock(client, "doc5", "v1 prose");
    await client.createComment("doc5", target, "about v1", PRINCIPAL);

    const edited = await client.editSection("doc5", target, "v2 prose");
    expect(edited.id).not.toBe(target);

    // The CURRENT block's thread includes the comment made on its predecessor.
    const threads = await client.listComments("doc5", edited.id);
    expect(threads[0]?.comments.map((c) => c.text)).toEqual(["about v1"]);
  });

  it("a deleted target reports deleted — never a silent orphan", async () => {
    const client = new FixtureBodyClient();
    const target = await seedOneBlock(client, "doc6", "doomed");
    await client.createComment("doc6", target, "on doomed", PRINCIPAL);
    await client.applySectionOps("doc6", [{ op: "delete", sectionId: target }]);

    const all = await client.listComments("doc6");
    expect(all).toHaveLength(1);
    expect(all[0]?.targetState).toBe("deleted");
    expect(all[0]?.comments.map((c) => c.text)).toEqual(["on doomed"]);
  });

  it("the document body is untouched by commentary", async () => {
    const client = new FixtureBodyClient();
    const target = await seedOneBlock(client, "doc7", "only block");
    const before = await client.readBody("doc7");
    await client.createComment("doc7", target, "noise", PRINCIPAL);
    await client.createComment("doc7", target, "more noise", OTHER);
    expect(await client.readBody("doc7")).toEqual(before);
  });
});
