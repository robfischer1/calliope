import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { NodeBodyEditor } from "../src/NodeBodyEditor.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import type { BlockOp, BlockOpEmitter } from "../src/types.js";

/** Collects emitted block-ops for test assertions. */
class FakeBlockOpEmitter implements BlockOpEmitter {
  readonly ops: BlockOp[] = [];
  emit(op: BlockOp): void {
    this.ops.push(op);
  }
}

afterEach(cleanup);

describe("NodeBodyEditor", () => {
  it("renders an existing body's prose", async () => {
    const client = new FixtureBodyClient({
      n1: [{ text: "hello world" }, { text: "## A Heading" }],
    });
    render(<NodeBodyEditor nodeId="n1" client={client} />);
    await waitFor(() => {
      expect(screen.getByText("hello world")).toBeDefined();
    });
    // Heading prose renders without the ## marker.
    expect(screen.getByText("A Heading")).toBeDefined();
  });

  it("hides the save footer when readOnly", async () => {
    const client = new FixtureBodyClient({ n1: [{ text: "x" }] });
    render(<NodeBodyEditor nodeId="n1" client={client} readOnly />);
    await waitFor(() => {
      expect(screen.getByText("x")).toBeDefined();
    });
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("shows a save footer when editable", async () => {
    const client = new FixtureBodyClient({ n1: [{ text: "x" }] });
    render(<NodeBodyEditor nodeId="n1" client={client} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /save/i })).toBeDefined();
    });
  });
});

describe("NodeBodyEditor — block-op emitter wiring (F3)", () => {
  it("accepts a blockOpEmitter prop without throwing", async () => {
    const client = new FixtureBodyClient({ n1: [{ text: "hello" }] });
    const emitter = new FakeBlockOpEmitter();
    render(
      <NodeBodyEditor nodeId="n1" client={client} blockOpEmitter={emitter} />,
    );
    await waitFor(() => {
      expect(screen.getByText("hello")).toBeDefined();
    });
    // No block-ops yet — no save triggered; emitter is wired but silent.
    expect(emitter.ops).toHaveLength(0);
  });

  it("renders the existing body prose when blockOpEmitter is wired", async () => {
    const client = new FixtureBodyClient({
      n2: [{ text: "block one" }, { text: "block two" }],
    });
    const emitter = new FakeBlockOpEmitter();
    render(
      <NodeBodyEditor nodeId="n2" client={client} blockOpEmitter={emitter} />,
    );
    await waitFor(() => {
      expect(screen.getByText("block one")).toBeDefined();
    });
    expect(screen.getByText("block two")).toBeDefined();
  });
});
