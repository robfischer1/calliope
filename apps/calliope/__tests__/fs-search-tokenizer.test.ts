import { describe, expect, it } from "vitest";
import {
  basicTokenize,
  WordPieceTokenizer,
} from "../src/fs-search/tokenizer.js";

// Minimal inline vocab — real BERT-uncased ids for the tokens used here, so
// the acceptance ids ([101, 7592, 2088, 102]) are the genuine article without
// shipping the 711 KB tokenizer.json into the repo.
const VOCAB: Record<string, number> = {
  "[PAD]": 0,
  "[UNK]": 100,
  "[CLS]": 101,
  "[SEP]": 102,
  hello: 7592,
  world: 2088,
  play: 2377,
  "##ing": 2075,
  ".": 1012,
};

const tokenizer = new WordPieceTokenizer(VOCAB);

describe("basicTokenize", () => {
  it("lowercases, strips accents, isolates punctuation", () => {
    expect(basicTokenize("Héllo, World.")).toEqual([
      "hello",
      ",",
      "world",
      ".",
    ]);
  });
});

describe("WordPieceTokenizer", () => {
  it('encodes "hello world" to the canonical BERT ids', () => {
    const { ids } = tokenizer.encode("hello world");
    expect(ids).toEqual([101, 7592, 2088, 102]);
  });

  it("longest-match WordPiece with ## continuations", () => {
    const { ids } = tokenizer.encode("playing");
    expect(ids).toEqual([101, 2377, 2075, 102]);
  });

  it("unknown words become [UNK]", () => {
    const { ids } = tokenizer.encode("zzzqqq");
    expect(ids).toEqual([101, 100, 102]);
  });

  it("truncates at maxLen keeping [SEP]", () => {
    const { ids, length } = tokenizer.encode("hello ".repeat(500), 16);
    expect(length).toBeLessThanOrEqual(16);
    expect(ids[0]).toBe(101);
    expect(ids[ids.length - 1]).toBe(102);
  });

  it("fromTokenizerJson reads the Xenova layout", () => {
    const json = JSON.stringify({ model: { vocab: VOCAB } });
    const fromJson = WordPieceTokenizer.fromTokenizerJson(json);
    expect(fromJson.encode("hello").ids).toEqual([101, 7592, 102]);
  });
});
