import type { BodyClient } from "../../src/types.js";

/** A minimal {@link BodyClient} whose unimplemented verbs THROW — post-F14
 *  the interface has no optional capabilities to leave absent, so a test
 *  needing a partial backend states the parts it means and the rest refuse
 *  loudly instead of silently vanishing from the surface. */
export function bareClient(overrides: Partial<BodyClient>): BodyClient {
  const refuse = (what: string) => (): Promise<never> =>
    Promise.reject(new Error(`stub: ${what} is not part of this test`));
  return {
    readBody: refuse("readBody"),
    saveBody: refuse("saveBody"),
    editSection: refuse("editSection"),
    applySectionOps: refuse("applySectionOps"),
    readRevisions: refuse("readRevisions"),
    readRevisionAt: refuse("readRevisionAt"),
    hasBody: refuse("hasBody"),
    ...overrides,
  };
}
