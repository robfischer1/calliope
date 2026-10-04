import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  computeTagDelta,
  extractInlineTags,
  isJunkTag,
  maskCode,
  normalizeTag,
} from "../src/tags.js";
import { FixtureTagStore, PgTagStore } from "../src/tag-store.js";
import { planTagCleanup } from "../src/mcp/cleanup-tags.js";

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

  it("never reads a tag inside an inline code span (Obsidian's rule)", () => {
    // The three measured mints: a space INSIDE the span met the boundary.
    expect(extractInlineTags("merge on `closes #issue` mapping")).toEqual([]);
    expect(extractInlineTags("the leg holds `JOIN #forge` always")).toEqual([]);
    expect(extractInlineTags("inline `#Alpha #beta` extract")).toEqual([]);
    // A double-backtick span may hold a single backtick and still close.
    expect(extractInlineTags("``a ` #nope`` then #yes")).toEqual(["#yes"]);
    // A word right after a span still sits on a boundary.
    expect(extractInlineTags("`x` #after")).toEqual(["#after"]);
  });

  it("an unpaired backtick run is literal text, not a span", () => {
    expect(extractInlineTags("a stray ` then #real")).toEqual(["#real"]);
    // Runs pair by EXACT width: a single cannot close a double.
    expect(extractInlineTags("``open ` #still-code ` x``")).toEqual([]);
    expect(extractInlineTags("``never closed ` #live")).toEqual(["#live"]);
  });

  it("never reads a tag inside a fenced code block", () => {
    const body = ["#before", "```bash", " #comment", "```", "#after"].join(
      "\n",
    );
    expect(extractInlineTags(body)).toEqual(["#after", "#before"]);
    // Tilde fences, indented up to three spaces.
    expect(extractInlineTags("   ~~~\n #in\n   ~~~\n #out")).toEqual(["#out"]);
  });

  it("closes a fence only on the same character, at least as long, bare", () => {
    // A backtick line does not close a tilde fence.
    expect(extractInlineTags("~~~\n```\n #in\n~~~\n #out")).toEqual(["#out"]);
    // A shorter run does not close; the longer one does.
    expect(extractInlineTags("````\n```\n #in\n`````\n #out")).toEqual([
      "#out",
    ]);
    // A closer may not carry trailing text.
    expect(extractInlineTags("```\n``` x\n #in\n```\n #out")).toEqual(["#out"]);
    // Trailing whitespace after a closer is fine.
    expect(extractInlineTags("```\n #in\n```  \n #out")).toEqual(["#out"]);
    // Four spaces of indent is not a fence.
    expect(extractInlineTags("    ```\n #live")).toEqual(["#live"]);
    // An unclosed fence runs to the end.
    expect(extractInlineTags("```\n #in\n #also-in")).toEqual([]);
  });

  it("maskCode keeps line structure and blanks spans to spaces", () => {
    expect(maskCode("a `b` c")).toBe("a     c");
    expect(maskCode("x\n```\ncode\n```\ny")).toBe("x\n\n\n\ny");
    expect(maskCode("no code")).toBe("no code");
    // An unpaired run survives verbatim.
    expect(maskCode("a ` b")).toBe("a ` b");
    // Text between spans is kept even when it repeats.
    expect(maskCode("a`b`a")).toBe("a   a");
    // Text after a span never pairs like a run, even with an equal later part.
    expect(maskCode("`x`q`q")).toBe("   q`q");
    // A span opened by a double run closes only on a double run.
    expect(extractInlineTags("`` #x ` ``")).toEqual([]);
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

describe("TagStore.carriers", () => {
  it("the fixture answers carriers sorted, whatever the insert order", async () => {
    const store = new FixtureTagStore();
    await store.upsert("n2", "#a", "inline");
    await store.upsert("n1", "#a", "inline");
    await store.upsert("n3", "#b", "inline");
    expect(await store.carriers("#a")).toEqual(["n1", "n2"]);
    expect(await store.carriers("#none")).toEqual([]);
  });

  it("PgTagStore asks the mirror for the tag's node ids", async () => {
    const query = vi.fn(() =>
      Promise.resolve({ rows: [{ node_id: "n1" }, { node_id: "n2" }] }),
    );
    const store = new PgTagStore({ query } as unknown as Pool);
    expect(await store.carriers("#we")).toEqual(["n1", "n2"]);
    expect(query).toHaveBeenCalledWith(
      "SELECT node_id FROM note_tags WHERE tag = $1 ORDER BY node_id",
      ["#we"],
    );
  });
});

describe("FixtureTagStore", () => {
  it("F11: normalizeTag strips trailing slashes; isJunkTag flags hex shapes", () => {
    expect(normalizeTag("#brainsoup/")).toBe("#brainsoup");
    expect(normalizeTag("brainsoup//")).toBe("#brainsoup");
    expect(normalizeTag("#Brain-Soup")).toBe("#brain-soup");
    // Hex-color shapes at CSS lengths are junk; others are not.
    for (const junk of ["#a6d189", "#fff", "#cafe", "#deadbeef"]) {
      expect(isJunkTag(junk), junk).toBe(true);
    }
    for (const fine of ["#brain-soup", "#f9", "#abcde", "#journal", "#cafes"]) {
      expect(isJunkTag(fine), fine).toBe(false);
    }
  });

  it("F11: computeTagDelta drops junk on both provenance paths", () => {
    const delta = computeTagDelta([], {
      explicit: ["#a6d189", "#keepme"],
      inline: ["#babbf1", "#alsokeep"],
    });
    expect(delta.toAdd.map((r) => r.tag).sort()).toEqual([
      "#alsokeep",
      "#keepme",
    ]);
    // A standing junk row reconciles OUT on the next inline write.
    const heal = computeTagDelta([{ tag: "#ca9ee6", source: "inline" }], {
      inline: ["#fine"],
    });
    expect(heal.toRemove).toEqual(["#ca9ee6"]);
  });

  it("F11: planTagCleanup removes junk and merges slash variants", () => {
    const plan = planTagCleanup([
      { tag: "#a6d189", count: 1 },
      { tag: "#brainsoup/", count: 1 },
      { tag: "#brain-soup", count: 4 },
      { tag: "#journal", count: 9 },
    ]);
    expect(plan.remove).toEqual(["#a6d189"]);
    expect(plan.merge).toEqual([["#brainsoup/", "#brainsoup"]]);
    // Idempotence: a clean enumeration plans nothing.
    expect(
      planTagCleanup([
        { tag: "#brain-soup", count: 4 },
        { tag: "#brainsoup", count: 1 },
      ]),
    ).toEqual({ remove: [], merge: [] });
  });

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
