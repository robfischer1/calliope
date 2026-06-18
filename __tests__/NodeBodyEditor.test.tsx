import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { NodeBodyEditor } from "../src/NodeBodyEditor.js";
import { FixtureBodyClient } from "../src/fixture-client.js";

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
