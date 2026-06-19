import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { docToTexts, textsToDoc } from "../src/prosemirror.js";

/** Does any node in the doc have this type name? */
function hasNode(doc: PMNode, typeName: string): boolean {
  let found = false;
  doc.descendants((n) => {
    if (n.type.name === typeName) found = true;
  });
  return found;
}

/** Does any text node in the doc carry this mark? */
function hasMark(doc: PMNode, markName: string): boolean {
  let found = false;
  doc.descendants((n) => {
    if (n.marks.some((m) => m.type.name === markName)) found = true;
  });
  return found;
}

describe("prosemirror markdown mapping", () => {
  // The regression: a single section is a whole markdown document. The old
  // schema shoved it into one literal paragraph (`**`, `##`, `-` shown raw);
  // it must now parse into formatted blocks.
  it("renders a single markdown section as formatted blocks, not literal source", () => {
    const md = [
      "**Serves:** the contract",
      "",
      "## Why",
      "- one",
      "- two",
      "",
      "Use `POST /turns`.",
    ].join("\n");
    const doc = textsToDoc([md]);

    expect(doc.childCount).toBeGreaterThan(1); // not one literal paragraph
    expect(hasNode(doc, "heading")).toBe(true);
    expect(hasNode(doc, "bullet_list")).toBe(true);
    expect(hasMark(doc, "strong")).toBe(true);
    expect(hasMark(doc, "code")).toBe(true);
    // No raw markdown punctuation leaked into the rendered text.
    expect(doc.textContent).not.toContain("**");
    expect(doc.textContent).not.toContain("## ");
  });

  it("renders an h2 heading without its marker", () => {
    const doc = textsToDoc(["## A Heading", "body text"]);
    expect(doc.firstChild?.type.name).toBe("heading");
    expect(doc.firstChild?.textContent).toBe("A Heading");
  });

  it("joins multiple sections into one document, preserving order", () => {
    const doc = textsToDoc(["first para", "## Second", "third"]);
    const text = doc.textContent;
    expect(text.indexOf("first para")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Second")).toBeGreaterThan(text.indexOf("first para"));
    expect(text.indexOf("third")).toBeGreaterThan(text.indexOf("Second"));
  });

  it("round-trips a markdown body to a single section, preserving formatting", () => {
    const md = "## A Heading\n\nbody **bold** text\n\n- a\n- b";
    const out = docToTexts(textsToDoc([md]));
    expect(out).toHaveLength(1); // one section = one body
    // Re-parsing the serialized markdown keeps the structure.
    const doc2 = textsToDoc(out);
    expect(hasNode(doc2, "heading")).toBe(true);
    expect(hasNode(doc2, "bullet_list")).toBe(true);
    expect(hasMark(doc2, "strong")).toBe(true);
  });

  it("empty body yields a blank paragraph doc and saves an empty body", () => {
    const doc = textsToDoc([]);
    expect(doc.childCount).toBe(1);
    expect(doc.firstChild?.type.name).toBe("paragraph");
    expect(docToTexts(doc)).toEqual([]);
  });

  it("drops blank sections on the way in", () => {
    const doc = textsToDoc(["real", "", "   "]);
    expect(docToTexts(doc)).toEqual(["real"]);
  });
});
