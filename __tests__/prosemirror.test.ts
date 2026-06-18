import { describe, expect, it } from "vitest";
import { docToTexts, textsToDoc } from "../src/prosemirror.js";

describe("prosemirror mapping", () => {
  it("round-trips paragraphs", () => {
    const texts = ["first para", "second para"];
    expect(docToTexts(textsToDoc(texts))).toEqual(texts);
  });

  it("round-trips h2 headings via the ## prefix", () => {
    const texts = ["## A Heading", "body text"];
    const doc = textsToDoc(texts);
    // The heading block carries no prefix internally...
    expect(doc.firstChild?.type.name).toBe("heading");
    expect(doc.firstChild?.textContent).toBe("A Heading");
    // ...but serializes back with the marker.
    expect(docToTexts(doc)).toEqual(texts);
  });

  it("empty body yields a blank paragraph doc", () => {
    const doc = textsToDoc([]);
    expect(doc.childCount).toBe(1);
    expect(doc.firstChild?.type.name).toBe("paragraph");
  });

  it("drops blank blocks on save", () => {
    const doc = textsToDoc(["real", "", "   "]);
    expect(docToTexts(doc)).toEqual(["real"]);
  });
});
