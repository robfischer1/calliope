import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** One write_container op, as the MCP schema takes it. */
export type BornOp =
  | { op: "add"; text: string; position: string }
  | { op: "update"; slot: string; oldBlobId: string; text: string };

/**
 * The ops that put `text` into a container the way real writers (mnemosyne,
 * demeter) do. A note minted by create_note is born holding ONE empty block,
 * so a writer fills that block with an `update` rather than adding a second
 * one beside it. A container with no lone empty block (a non-note, or a
 * block already written) takes the `add` at `position` instead.
 */
export async function fillOps(
  mcp: Client,
  container: string,
  text: string,
  position = "a0",
): Promise<BornOp[]> {
  const read = await mcp.callTool({
    name: "read_container",
    arguments: { container },
  });
  const blocks =
    (
      read.structuredContent as
        { blocks: { slot: string; blobId: string; text: string }[] } | undefined
    )?.blocks ?? [];
  const born = blocks.length === 1 ? blocks[0] : undefined;
  if (born?.text === "") {
    return [{ op: "update", slot: born.slot, oldBlobId: born.blobId, text }];
  }
  return [{ op: "add", text, position }];
}
