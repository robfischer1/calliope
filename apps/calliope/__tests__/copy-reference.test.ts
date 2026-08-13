// ── 024/F1: the compound copy-reference — `[[<title>]] (<id>)` ───────────────

import { describe, expect, it } from "vitest";
import { FixtureChaosDial } from "../src/chaos-client.js";
import {
  copyReference,
  createNote,
  formatCompoundReference,
  isCopyReferenceError,
  isCreateNoteError,
} from "../src/mcp/tools.js";

const SCOPE = "notes";

describe("formatCompoundReference — the one formatter", () => {
  it("emits `[[title]] (id)` with both halves echoed", () => {
    const r = formatCompoundReference("My Note", "abc123");
    expect(r.compound).toBe("[[My Note]] (abc123)");
    expect(r.wikilink).toBe("[[My Note]]");
    expect(r.id).toBe("abc123");
    expect(r.title).toBe("My Note");
  });

  it("strips newlines from the title, emits everything else verbatim", () => {
    const r = formatCompoundReference("line one\nline two", "x");
    expect(r.compound).toBe("[[line one line two]] (x)");
    // wikilink-hostile characters pass through — the id half carries
    // resolution; a strange title degrades recognition, never the address.
    const odd = formatCompoundReference("a|b ]] c", "y");
    expect(odd.wikilink).toBe("[[a|b ]] c]]");
  });
});

describe("copyReference — graph-backend form (the chaos dial)", () => {
  it("resolves the title from the node dictionary, full id, node form", async () => {
    const dial = new FixtureChaosDial();
    const minted = await createNote(dial, SCOPE, { title: "F9 Archaeology" });
    expect(isCreateNoteError(minted)).toBe(false);
    if (isCreateNoteError(minted)) return;

    const r = await copyReference(dial, minted.node_id);
    expect(isCopyReferenceError(r)).toBe(false);
    if (isCopyReferenceError(r)) return;
    expect(r.compound).toBe(`[[F9 Archaeology]] (${minted.node_id})`);
    expect(r.title).toBe("F9 Archaeology");
    expect(r.id).toBe(minted.node_id);
    expect(r.address_form).toBe("node");
  });

  it("misses structurally on an unknown token", async () => {
    const dial = new FixtureChaosDial();
    const r = await copyReference(dial, "00".repeat(32));
    expect(isCopyReferenceError(r)).toBe(true);
    if (!isCopyReferenceError(r)) return;
    expect(r.error).toBe("unknown_node");
    expect(r.detail).toContain("resolves to no node");
  });
});
