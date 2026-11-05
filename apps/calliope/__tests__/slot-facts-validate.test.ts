/**
 * Pins slot-facts validation messages and the span-window retract/held
 * helpers, so a mutated literal, regex, predicate name or filter changes an
 * observable result.
 */

import { describe, expect, it } from "vitest";
import type { NodeEdge } from "../src/chaos-client.js";
import {
  heldSpanFacts,
  retractSpanOps,
  validateSlotFacts,
} from "../src/slot-facts.js";

const lit = (predicate: string, literal: string) => ({ predicate, literal });
const check = (predicate: string, literal: string) =>
  validateSlotFacts([lit(predicate, literal)], "t", "add");

describe("span bound validation", () => {
  it.each(["spanFrom", "spanTo"])(
    "%s accepts integer seqs, -1 included",
    (p) => {
      expect(check(p, "0")).toEqual([lit(p, "0")]);
      expect(check(p, "-1")).toEqual([lit(p, "-1")]);
      expect(check(p, "1116")).toEqual([lit(p, "1116")]);
    },
  );

  it.each(["spanFrom", "spanTo"])(
    "%s rejects a non-integer, naming it",
    (p) => {
      for (const bad of ["abc", "1x", "x1", "1.5", "--1", "1-", " 1"]) {
        expect(() => check(p, bad)).toThrow(
          `facts: ${p} must be an integer seq`,
        );
      }
    },
  );

  it("only the span bounds are held to the seq pattern", () => {
    expect(check("legacyId", "7")).toEqual([lit("legacyId", "7")]);
    expect(check("signedAs", "not-a-number")).toEqual([
      lit("signedAs", "not-a-number"),
    ]);
  });
});

describe("turnsDigest validation", () => {
  it("accepts exactly 16 lower-case hex", () => {
    expect(check("turnsDigest", "0123456789abcdef")).toEqual([
      lit("turnsDigest", "0123456789abcdef"),
    ]);
  });

  it("rejects wrong length, case, alphabet and surrounding junk", () => {
    const bad = [
      "0123456789abcde",
      "0123456789abcdef0",
      "0123456789ABCDEF",
      "0123456789abcdeg",
      "zz0123456789abcdef",
      "0123456789abcdef\n",
      "  0123456789abcdef",
    ];
    for (const b of bad) {
      expect(() => check("turnsDigest", b)).toThrow(
        "facts: turnsDigest must be 16 lower-case hex",
      );
    }
  });

  it("does not apply the digest pattern to other predicates", () => {
    expect(check("signedAs", "short")).toEqual([lit("signedAs", "short")]);
  });
});

const edge = (
  predicate: string,
  value: string,
  domain: NodeEdge["domain"] = "scalar",
): NodeEdge => ({ predicate, value, isNode: domain === "node", domain });
const removed = (ops: ReturnType<typeof retractSpanOps>) =>
  ops.map((o) => `${String(o.predicate)}=${String(o.to_literal)}`).sort();

describe("retractSpanOps", () => {
  const held = [
    edge("spanFrom", "0"),
    edge("spanTo", "9"),
    edge("turnsDigest", "aaaaaaaaaaaaaaaa"),
    edge("quotes", "q"),
  ];

  it("is empty when the update carries no window bound", () => {
    expect(retractSpanOps("s", held, [])).toEqual([]);
    expect(retractSpanOps("s", held, [lit("quotes", "q2")])).toEqual([]);
    expect(
      retractSpanOps("s", held, [lit("turnsDigest", "bbbbbbbbbbbbbbbb")]),
    ).toEqual([]);
  });

  it("a new spanFrom alone retracts spanFrom and the digest only", () => {
    expect(removed(retractSpanOps("s", held, [lit("spanFrom", "5")]))).toEqual([
      "spanFrom=0",
      "turnsDigest=aaaaaaaaaaaaaaaa",
    ]);
  });

  it("a new spanTo alone retracts spanTo and the digest only", () => {
    expect(removed(retractSpanOps("s", held, [lit("spanTo", "5")]))).toEqual([
      "spanTo=9",
      "turnsDigest=aaaaaaaaaaaaaaaa",
    ]);
  });

  it("never retracts a non-span predicate carried alongside", () => {
    const ops = retractSpanOps("s", held, [
      lit("spanFrom", "5"),
      lit("quotes", "q2"),
    ]);
    expect(removed(ops)).not.toContain("quotes=q");
  });

  it("leaves a value carried again in place", () => {
    expect(
      removed(
        retractSpanOps("s", held, [lit("spanFrom", "0"), lit("spanTo", "5")]),
      ),
    ).toEqual(["spanTo=9", "turnsDigest=aaaaaaaaaaaaaaaa"]);
  });

  it("retracts only scalar edges, not a node-domain one", () => {
    const ops = retractSpanOps(
      "s",
      [edge("spanFrom", "0", "node"), edge("spanFrom", "1", "blob")],
      [lit("spanFrom", "5")],
    );
    expect(ops).toEqual([]);
  });

  it("targets the slot it is given", () => {
    const [op] = retractSpanOps(
      "slot-1",
      [edge("spanTo", "9")],
      [lit("spanTo", "5")],
    );
    expect(op).toMatchObject({
      op: "removeEdge",
      from_id: "slot-1",
      predicate: "spanTo",
      to_literal: "9",
    });
  });
});

describe("heldSpanFacts", () => {
  it("keeps carried span facts already held as sent", () => {
    const facts = [lit("spanFrom", "0"), lit("spanTo", "5")];
    expect(
      heldSpanFacts([edge("spanFrom", "0"), edge("spanTo", "9")], facts),
    ).toEqual([lit("spanFrom", "0")]);
  });

  it("does not count a node-domain or blob edge as held", () => {
    const facts = [lit("spanFrom", "0"), lit("spanTo", "9")];
    expect(
      heldSpanFacts(
        [edge("spanFrom", "0", "node"), edge("spanTo", "9", "blob")],
        facts,
      ),
    ).toEqual([]);
  });

  it("ignores non-span predicates even when held", () => {
    expect(heldSpanFacts([edge("quotes", "q")], [lit("quotes", "q")])).toEqual(
      [],
    );
  });
});
