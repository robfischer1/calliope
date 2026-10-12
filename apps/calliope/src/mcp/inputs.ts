/**
 * The input-schema pieces more than one verb shares. Each verb's schema is a
 * closed `z.strictObject` with every site described; the door
 * (`enforceInputSchemas`, stellar-core-ts) refuses a missing required field
 * and an undeclared one as `bad_args` before a handler runs, and the
 * schematest kit (`__tests__/input-schemas.test.ts`) holds every schema to
 * its handler.
 */
import { z } from "zod";
import { NODE_TOKEN_RE } from "../types.js";

export { NODE_TOKEN_RE };

/** A described node-token string. */
export function nodeToken(description: string): z.ZodString {
  return z.string().regex(NODE_TOKEN_RE).describe(description);
}
