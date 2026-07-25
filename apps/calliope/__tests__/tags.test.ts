import { describe, expect, it } from "vitest";
import {
  computeTagDelta,
  extractInlineTags,
  normalizeTag,
} from "../src/tags.js";
import { FixtureTagStore } from "../src/tag-store.js";

describe("extractInlineTags — the scan.ts grammar, mirrored", () => {
  it("extracts word-start tags, normalized lowercase, deduped + sorted", () => {
    expect(
      extractInlineTags("a #Journal note with #brain-soup and #journal"),
    ).toEqual(["#brain-soup", "#journal"]);
  });

  it("honors the grammar: letter head, path segments, no mid-word hits", () => {
    expect(extractInlineTags("#a/b nested")).toEqual(["#a/b"]);
    expect(extractInlineTags("x#not-a-tag")).toEqual([]);
    expect(extractInlineTags("#9nope leading digit")).toEqual([]);
    expect(extractInlineTags("##nope double hash")).toEqual([]);
  });

  it("only whitespace or text-start is a valid boundary — not punctuation", () => {
    // Rob's own inline convention always has a space (or line-start) ahead of
    // a #tag; anything else (parens, slashes, ...) is text that merely
    // contains a `#`, not an authored tag.
    expect(extractInlineTags("(#no) parens aren't boundaries")).toEqual([]);
    expect(extractInlineTags("line one\n#yes at line start")).toEqual(["#yes"]);
  });

  it("does not sweep in a URL fragment's #-prefixed path segment", () => {
    // A quoted Gmail permalink's `.../u/0/#inbox/FMfcgz...` used to read as
    // a tag because `/` qualified as a boundary before the tightening above.
    expect(
      extractInlineTags(
        "From <https://mail.google.com/mail/u/0/#inbox/FMfcgzGrblhftmnGmMDXhFFlnVnRqHxL>",
      ),
    ).toEqual([]);
  });

  it("excludes hex color shorthands but keeps real words at the same lengths", () => {
    expect(
      extractInlineTags("swatch #fff and accent #deadbeef and #cafe"),
    ).toEqual([]);
    // #4a90d9 never reaches the hex filter — the grammar already excludes a
    // digit-led body, so this is really testing the letter-head rule stays
    // in force.
    expect(extractInlineTags("css var #4a90d9 unchanged")).toEqual([]);
    expect(extractInlineTags("#deadline is not a color")).toEqual([
      "#deadline",
    ]);
  });

  it("normalizeTag canonicalizes with or without the hash", () => {
    expect(normalizeTag("Journal")).toBe("#journal");
    expect(normalizeTag("#Brain-Soup")).toBe("#brain-soup");
  });
});

describe("computeTagDelta — the reconcile matrix", () => {
  it("inline replaces inline; explicit is untouchable", () => {
    const standing = [
      { tag: "#a", source: "inline" as const },
      { tag: "#b", source: "inline" as const },
      { tag: "#journal", source: "explicit" as const },
    ];
    const delta = computeTagDelta(standing, { inline: ["#b", "#c"] });
    expect(delta.toAdd).toEqual([{ tag: "#c", source: "inline" }]);
    expect(delta.toRemove).toEqual(["#a"]);
  });

  it("explicit is additive and never demotes or removes", () => {
    const standing = [{ tag: "#x", source: "inline" as const }];
    const delta = computeTagDelta(standing, { explicit: ["#x", "#journal"] });
    expect(delta.toAdd).toEqual([{ tag: "#journal", source: "explicit" }]);
    expect(delta.toRemove).toEqual([]);
  });

  it("a tag both inline and standing-explicit stays explicit, survives", () => {
    const standing = [{ tag: "#journal", source: "explicit" as const }];
    const delta = computeTagDelta(standing, { inline: [] });
    expect(delta.toAdd).toEqual([]);
    expect(delta.toRemove).toEqual([]);
  });
});

describe("FixtureTagStore", () => {
  it("upsert keeps first provenance; distinct counts carriers", async () => {
    const store = new FixtureTagStore();
    await store.upsert("n1", "#a", "explicit");
    await store.upsert("n1", "#a", "inline"); // no demote
    await store.upsert("n2", "#a", "inline");
    await store.upsert("n2", "#b", "inline");
    expect(await store.byNode("n1")).toEqual([
      { tag: "#a", source: "explicit" },
    ]);
    expect(await store.distinct()).toEqual([
      { tag: "#a", count: 2 },
      { tag: "#b", count: 1 },
    ]);
    await store.remove("n2", "#a");
    expect(await store.distinct()).toEqual([
      { tag: "#a", count: 1 },
      { tag: "#b", count: 1 },
    ]);
  });
});
