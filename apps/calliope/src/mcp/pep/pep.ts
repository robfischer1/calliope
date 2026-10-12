/**
 * The endpoint PEP, armed: mode machine, sidecar, counters. The TS peer of
 * stellar-core-go `policy/pep.go`.
 *
 * THE MODE MACHINE IS THE WHOLE SAFETY STORY.
 *
 *  - witness (the default): every decision is computed, recorded on the call's
 *    own record and counted, and NOTHING IS EVER REFUSED.
 *  - enforce: a call whose decision is not allow is REFUSED before its handler
 *    runs ({@link ./enforce.ts}). The flip is one env line, and so is the
 *    rollback.
 *  - anything else is a MIS-SET SWITCH: the star runs as witness (refuses
 *    nothing) and says so in one loud line quoting the value. Safe default,
 *    keep running.
 *
 * FAIL-CLOSED BOOT. Unlike Go (which boots a witnessing star without a sidecar
 * and an enforcing one with a broken sidecar), this PEP refuses to START when
 * the composed sidecar is missing or does not parse, in either mode. Calliope
 * has one inbound door and no PEP-less period to preserve: a pod that cannot
 * read its own ACL is a deploy defect, and a rolling update holds the old pod
 * rather than serve one.
 */

import { loadAcl } from "./acl.js";
import type { Acl } from "./acl.js";
import { consumerOf, decide } from "./decide.js";
import type { Decision, Input } from "./decide.js";
import { enforced } from "./enforce.js";

export type Mode = "witness" | "enforce";

/** The env a star's PEP is configured by (the names the Go stars use). */
export const ENV_MODE = "STELLAR_PEP_MODE";
export const ENV_SIDECAR = "STELLAR_ORBIT_SIDECAR";

/** Where the composed orbit.toml is mounted when {@link ENV_SIDECAR} is unset. */
export const DEFAULT_SIDECAR_PATH = "/etc/stellar/orbit.toml";

/** The sidecar is missing or unparseable: the star must not start. */
export class PepBootError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PepBootError";
  }
}

/** The mode a raw `STELLAR_PEP_MODE` value arms: unset/empty and the two modes
 *  are themselves/the default; anything else is witness (`recognized: false`),
 *  because a mis-set switch never enforces and never stops the star. */
export function resolveMode(raw: string | undefined): {
  mode: Mode;
  recognized: boolean;
} {
  if (raw === undefined || raw === "")
    return { mode: "witness", recognized: true };
  if (raw === "witness" || raw === "enforce")
    return { mode: raw, recognized: true };
  return { mode: "witness", recognized: false };
}

export interface PepConfig {
  readonly star: string;
  /** Raw mode value; undefined/empty means witness. */
  readonly mode?: string | undefined;
  /** The composed orbit.toml; undefined/empty means {@link DEFAULT_SIDECAR_PATH}. */
  readonly sidecarPath?: string | undefined;
  /** Receives the boot lines. Default: stderr (stdout belongs to a stdio MCP transport). */
  readonly log?: ((line: string) => void) | undefined;
}

/** {@link PepConfig} from the environment. */
export function pepConfigFromEnv(
  star: string,
  env: NodeJS.ProcessEnv = process.env,
): PepConfig {
  return {
    star,
    mode: env[ENV_MODE],
    sidecarPath: env[ENV_SIDECAR],
  };
}

const stderrLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** An armed policy enforcement point. */
export class Pep {
  private readonly tally = new Map<string, number>();

  constructor(
    readonly star: string,
    readonly mode: Mode,
    private readonly acl: Acl,
  ) {}

  /** How many consumers the sidecar declares. */
  get consumers(): number {
    return this.acl.size;
  }

  /** Adjudicate one call as this PEP's mode acts on it: witness's decision is
   *  {@link decide}'s verbatim; enforce closes what witness only records. */
  adjudicate(input: Input): Decision {
    const d = decide(this.acl, input);
    return this.mode === "enforce"
      ? enforced(this.acl, consumerOf(input.peer), d)
      : d;
  }

  /** Whether this PEP refuses a call decided as `d`. Witness refuses nothing. */
  refuses(d: Decision): boolean {
    return this.mode === "enforce" && d.verdict !== "allow";
  }

  /** Count one decision, as the `decision` label it was recorded under. */
  count(decision: string, reason: string): void {
    const key = `${this.mode}/${decision}/${reason}`;
    this.tally.set(key, (this.tally.get(key) ?? 0) + 1);
  }

  /** Decisions counted so far, keyed `mode/decision/reason` (Go's
   *  `stellar_pep_decisions_total{mode,decision,reason}`). */
  counts(): Record<string, number> {
    return Object.fromEntries(this.tally);
  }
}

/**
 * Arm a PEP, or throw {@link PepBootError}. The sidecar is read once, here: a
 * changed ConfigMap rolls the pod and the star re-reads at boot.
 */
export function loadPep(config: PepConfig): Pep {
  const log = config.log ?? stderrLine;
  const { mode, recognized } = resolveMode(config.mode);
  if (!recognized) {
    log(
      `${config.star}: pep: ${ENV_MODE}=${JSON.stringify(config.mode)} is not a PEP mode, ` +
        "running WITNESS, which refuses nothing; set witness or enforce",
    );
  }
  const path =
    config.sidecarPath === undefined || config.sidecarPath === ""
      ? DEFAULT_SIDECAR_PATH
      : config.sidecarPath;
  let acl: Acl;
  try {
    acl = loadAcl(config.star, path);
  } catch (err) {
    throw new PepBootError(
      `${config.star}: pep: refusing to start, the orbit sidecar at ${path} ` +
        `(${ENV_SIDECAR}) is missing or unparseable: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const pep = new Pep(config.star, mode, acl);
  log(
    `${config.star}: pep: ${mode === "enforce" ? "ENFORCING on" : "witnessing"} inbound calls ` +
      `(mode=${mode} sidecar=${path} consumers=${String(pep.consumers)})`,
  );
  return pep;
}
