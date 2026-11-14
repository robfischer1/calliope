import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { argsDigest, canonicalArgs, DigestError } from "../src/args-digest.js";

// Vectors computed by stellar-core-go elevation.ArgsDigest (copied verbatim
// from charon's __tests__/fixtures): the minting side binds these bytes.
interface Vector {
  in: string;
  canon: string;
  digest: string;
}
const VECTORS = JSON.parse(
  readFileSync(
    new URL("./fixtures/args-digest-vectors.json", import.meta.url),
    "utf8",
  ),
) as Vector[];

describe("args digest, against the Go vectors charon pins", () => {
  it("has the vectors", () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(18);
  });
  it.each(VECTORS.map((v) => [v.in, v] as const))(
    "canonical + digest match: %s",
    (_name, v) => {
      expect(canonicalArgs(v.in)).toBe(v.canon);
      expect(argsDigest(v.in)).toBe(v.digest);
    },
  );
  it("refuses non-objects and bad JSON", () => {
    for (const bad of ["[1]", '"x"', '{"a":1} x', "{", '{"a":1e999}']) {
      expect(() => argsDigest(bad)).toThrow(DigestError);
    }
  });
});
