/**
 * The offline guard: a suite that calls it reaches nothing but loopback.
 *
 * # Why this is a one-line import and not `setupFiles`
 *
 * It was `setupFiles` for one revision, which is what this guard WANTS to be:
 * the lesson of infra#9758's audit is that eight Python stars (terpsichore,
 * narcissus, themis, urania, chaos, iris, mnemosyne, thalassa) are immune to
 * the whole bug class because each carries an autouse `no_network` fixture in
 * `tests/conftest.py`, while stellar-core was exposed because it had no
 * conftest at all. A guard a future test inherits beats a guard a future test
 * must remember.
 *
 * The mutation lane refuses that wiring today, and the refusal is correct
 * behaviour meeting a gate limitation. `ts:mutation` scopes Stryker to THE
 * WHOLE DIFF — `*.ts *.tsx :!*.test.ts :!*.spec.ts :!*__tests__/* :!node_modules/`
 * (foundry-tools `TSMutationSpecs`) — and `vitest.config.ts` is a `.ts` outside
 * `__tests__/`, so touching it hands Stryker `--mutate vitest.config.ts:8-13`.
 * Stryker instruments the vitest CONFIG, finds no test related to it, and exits
 * `No tests were executed` — measured on calliope run
 * `mutation-calliope-e76bd37-62767`. A config file is not mutable code, but the
 * pathspec cannot tell.
 *
 * Renaming the config to dodge the pathspec, or declaring `critical_modules` to
 * narrow the scope, would both be routing around the gate rather than fixing
 * it — and the second NARROWS mutation coverage for the whole package to fix a
 * test-only problem. So this exports an installer instead. Wiring it back into
 * `setupFiles` is a one-line change the day `TSMutationSpecs` excludes config
 * files, and then every suite inherits it with no other edit.
 *
 * # What it is guarding against
 *
 * `cleanup-tags.ts` picks its dial with a CONDITION, not by construction:
 *
 * ```ts
 * sweepArchivedTags(deps.dial ?? new LiveChaosDial(), …)
 * ```
 *
 * Stryker's LogicalOperator mutator rewrites `??` to `&&`, and a `deps.dial`
 * that is merely truthy then makes the expression evaluate to the RIGHT side —
 * the fixture is discarded and a `LiveChaosDial` is built instead.
 * `src/mcp/*.ts` is in this package's Stryker `mutate` glob, so that mutant is
 * generated on every pull that touches the file. `LiveChaosDial`'s constructor
 * reads `process.env` — NOT the `env` object `main()` was handed — and falls
 * back to `https://chaos:8207` and `http://themis:8200`, which resolve in the
 * gate and mutation lanes because those run IN the cluster. The sweep's first
 * act is `find_by_value("notes", "isArchived", "true")`, enumerating the real
 * archived corpus off the live graph.
 *
 * # Why a fetch guard and not a socket guard
 *
 * Every fleet dial in this package goes out through global `fetch`
 * (`chaos-client.ts`'s `rpc`, the charon capture clients). Loopback stays open
 * on purpose: the real-postgres suites talk to a testcontainer, and a guard
 * that broke them would be turned off within a week, which is worse than no
 * guard.
 *
 * # This is ONE of two guards, and deliberately the weaker one
 *
 * It stops the HTTP leg. It does NOT stop `LiveChaosDial.tls()` reaching
 * `X509Source.create()` on the real Workload API socket, which happens for any
 * `https:` chaos URL before a byte is fetched. The per-file guard — pinning
 * `CALLIOPE_CHAOS_URL`/`CALLIOPE_THEMIS_URL` to a dead `http://` address — is
 * what closes that, and it closes the HTTP leg too. Neither is defeated by a
 * source mutant, which is the property #23 asked for; they are not symmetric,
 * and saying so is better than implying a coverage this file does not have.
 */
import { afterEach, beforeEach } from "vitest";

/**
 * A host a suite may still fetch: its own fixtures and testcontainers.
 *
 * Takes `URL.hostname`, NOT `URL.host` — `host` carries the port, so
 * `127.0.0.1:1` would compare unequal to `127.0.0.1` and loopback would be
 * refused along with everything else. That is not a hypothetical tidy-up: the
 * first run of this guard refused `http://127.0.0.1:1/mcp` while its own
 * comment claimed loopback stayed open. `hostname` also strips the brackets
 * from a v6 literal, which is why there is no unbracketing here.
 */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

const realFetch = globalThis.fetch;

/**
 * Refuses a non-loopback fetch by NAME, so a suite that trips this reads why
 * rather than reporting as a timeout thirty seconds later.
 */
const offlineFetch: typeof globalThis.fetch = (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = "";
  }
  if (hostname !== "" && !isLoopback(hostname)) {
    return Promise.reject(
      new Error(
        `offline guard: this suite tried to fetch ${url} — tests in this ` +
          `package reach nothing but loopback. A live host here means a fake ` +
          `was bypassed (see __tests__/setup/offline.ts).`,
      ),
    );
  }
  return realFetch(input, init);
};

/**
 * Arm the guard for the calling suite. Call once at module scope.
 *
 * Per-test, not once: a suite that installs its OWN fetch stub (hades-capture,
 * live-capture) restores whatever it found, and re-arming each time keeps the
 * guard in place for the next test whatever order they ran in.
 */
export function installOfflineGuard(): void {
  beforeEach(() => {
    globalThis.fetch = offlineFetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });
}
