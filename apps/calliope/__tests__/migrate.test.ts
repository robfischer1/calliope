/**
 * Migrator pure-function tests: content hashing, enumeration filters. The
 * end-to-end migration is exercised against live chaos + pg at cutover (the
 * parity gate is the arbiter — specs/002 T004); these pin the pieces that
 * decide what migrates and what parity means.
 */

import { describe, expect, it } from "vitest";
import {
  bodyOwners,
  contentHashOfBody,
  sectionNodes,
  type EdgeNode,
} from "../src/mcp/migrate.js";

const NODES: EdgeNode[] = [
  {
    id: "note-1",
    edges: [
      { predicate: "hasType", value: "Feature", is_node: false },
      { predicate: "hasPart", value: "sec-1", is_node: true },
      { predicate: "hasPart", value: "sec-2", is_node: true },
    ],
  },
  {
    id: "sec-1",
    edges: [
      { predicate: "hasType", value: "section", is_node: false },
      { predicate: "text", value: "hello", is_node: false },
      { predicate: "order_key", value: "01", is_node: false },
    ],
  },
  {
    id: "sec-2",
    edges: [
      { predicate: "hasType", value: "section", is_node: false },
      { predicate: "text", value: "world", is_node: false },
      { predicate: "order_key", value: "02", is_node: false },
    ],
  },
  {
    id: "plain-node",
    edges: [{ predicate: "hasType", value: "Goal", is_node: false }],
  },
];

describe("migrate enumeration", () => {
  it("bodyOwners = nodes with hasPart edges only", () => {
    expect(bodyOwners(NODES)).toEqual(["note-1"]);
  });

  it("sectionNodes = nodes typed section (current and superseded alike)", () => {
    expect(sectionNodes(NODES).map((n) => n.id)).toEqual(["sec-1", "sec-2"]);
  });
});

describe("parity hash", () => {
  it("is order-sensitive and text-sensitive", () => {
    const first = { id: "x", text: "one", orderKey: "01" };
    const second = { id: "y", text: "two", orderKey: "02" };
    const a = [first, second];
    const same = [
      { id: "DIFFERENT-ID", text: "one", orderKey: "01" },
      { id: "other", text: "two", orderKey: "02" },
    ];
    const reordered = [second, first];
    const edited = [first, { ...second, text: "changed" }];
    expect(contentHashOfBody(same)).toBe(contentHashOfBody(a)); // ids don't count
    expect(contentHashOfBody(reordered)).not.toBe(contentHashOfBody(a));
    expect(contentHashOfBody(edited)).not.toBe(contentHashOfBody(a));
  });

  it("empty body hashes stably", () => {
    expect(contentHashOfBody([])).toBe(contentHashOfBody([]));
  });
});
