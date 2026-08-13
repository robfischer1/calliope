/**
 * A hand-rolled BERT-uncased WordPiece tokenizer (Findability F2) — exactly
 * the preprocessing the MiniLM-class encoder expects, read from the model's
 * own `tokenizer.json` vocab. Hand-rolled deliberately: a tokenizer library
 * would drag an entire inference stack in for one function
 * (specs/033-search-verb/research.md).
 */

export interface EncodedInput {
  ids: number[];
  /** attention mask is all-ones at this grain (no padding within one text). */
  length: number;
}

interface TokenizerJson {
  model?: { vocab?: Record<string, number> };
}

const MAX_WORD_CHARS = 100;

export class WordPieceTokenizer {
  readonly #vocab: Map<string, number>;
  readonly #unk: number;
  readonly #cls: number;
  readonly #sep: number;

  constructor(vocab: Record<string, number>) {
    this.#vocab = new Map(Object.entries(vocab));
    const unk = this.#vocab.get("[UNK]");
    const cls = this.#vocab.get("[CLS]");
    const sep = this.#vocab.get("[SEP]");
    if (unk === undefined || cls === undefined || sep === undefined) {
      throw new Error("tokenizer: vocab is missing [UNK]/[CLS]/[SEP]");
    }
    this.#unk = unk;
    this.#cls = cls;
    this.#sep = sep;
  }

  /** Build from the model's tokenizer.json text (Xenova layout). */
  static fromTokenizerJson(json: string): WordPieceTokenizer {
    const parsed = JSON.parse(json) as TokenizerJson;
    const vocab = parsed.model?.vocab;
    if (vocab === undefined) {
      throw new Error("tokenizer: tokenizer.json carries no model.vocab");
    }
    return new WordPieceTokenizer(vocab);
  }

  /** `[CLS] …wordpieces… [SEP]`, truncated to `maxLen` total tokens. */
  encode(text: string, maxLen = 256): EncodedInput {
    const ids: number[] = [this.#cls];
    outer: for (const word of basicTokenize(text)) {
      for (const id of this.#wordpiece(word)) {
        if (ids.length >= maxLen - 1) break outer;
        ids.push(id);
      }
    }
    ids.push(this.#sep);
    return { ids, length: ids.length };
  }

  #wordpiece(word: string): number[] {
    if (word.length > MAX_WORD_CHARS) return [this.#unk];
    const pieces: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let found = -1;
      while (end > start) {
        const piece = (start === 0 ? "" : "##") + word.slice(start, end);
        const id = this.#vocab.get(piece);
        if (id !== undefined) {
          found = id;
          break;
        }
        end--;
      }
      if (found < 0) return [this.#unk];
      pieces.push(found);
      start = end;
    }
    return pieces;
  }
}

/** BERT-uncased basic tokenization: lowercase, strip accents, isolate
 *  punctuation, split whitespace. */
export function basicTokenize(text: string): string[] {
  const cleaned = text
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase();
  const out: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current !== "") {
      out.push(current);
      current = "";
    }
  };
  for (const ch of cleaned) {
    if (/\s/u.test(ch)) {
      flush();
    } else if (/[\p{P}\p{S}]/u.test(ch)) {
      flush();
      out.push(ch);
    } else {
      current += ch;
    }
  }
  flush();
  return out;
}
