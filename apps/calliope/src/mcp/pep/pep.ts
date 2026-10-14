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
 * BOOT. A sidecar that does not parse refuses the START, in either mode (Go
 * refuses it in witness and boots a refuse-everything star in enforce). A
 * MISSING sidecar boots in witness, as Go does: star callers record
 * would_deny{no_acl} and nothing is refused, so the bare image still starts
 * and serves (the build lane's boot smoke runs it with no mount). An enforcing
 * star with no sidecar refuses to start: there is no ACL to enforce.
 */

import { loadAcl, NoSidecarError } from "./acl.js";
import type { Acl } from "./acl.js";
import { consumerOf, decide } from "./decide.js";
import type { Decision, Input } from "./decide.js";
import { enforced } from "./enforce.js";
import type { DecisionRecorder } from "./metrics.js";
import { actionOf, consulted, pdpFromEnv } from "./pdp.js";
import type { Pdp } from "./pdp.js";

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
  /** The policy plane the non-service path asks; undefined = none wired. */
  readonly pdp?: Pdp | undefined;
  /** Receives every counted decision (the OTel counter); undefined = none. */
  readonly onDecision?: DecisionRecorder | undefined;
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
    pdp: pdpFromEnv(env),
  };
}

const stderrLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/**
 * Every reason an ENFORCING pep will refuse calls it would rather allow; empty
 * when none. The TS peer of stellar-core-go `enforcePreconditions`. Like Go's
 * they do not stop the boot (each gap's calls are refused, closed): they are
 * the boot line an operator reads after the flip. A missing or unparseable
 * sidecar never reaches here: {@link loadPep} refuses that start outright.
 */
export function enforcePreconditions(
  acl: Acl | undefined,
  hasPdp: boolean,
): string[] {
  const gaps: string[] = [];
  if (acl === undefined) {
    gaps.push("no orbit sidecar: every star caller is refused no_acl");
  } else if (acl.size === 0) {
    gaps.push("an EMPTY rule set: every star caller is refused no_edge");
  } else if (!acl.allApproved()) {
    gaps.push(
      "generated contracts: their callers are refused edge_not_approved",
    );
  }
  if (!hasPdp) {
    gaps.push(
      "no PDP: every gateway and non-star caller is refused pdp_not_consulted",
    );
  }
  return gaps;
}

/** An armed policy enforcement point. */
export class Pep {
  private readonly tally = new Map<string, number>();

  constructor(
    readonly star: string,
    readonly mode: Mode,
    /** Undefined = no sidecar (witness only): star callers decide `no_acl`. */
    private readonly acl: Acl | undefined,
    private readonly pdp?: Pdp,
    private readonly onDecision?: DecisionRecorder,
  ) {}

  /** Whether a policy plane is wired. */
  get hasPdp(): boolean {
    return this.pdp !== undefined;
  }

  /** How many consumers the sidecar declares (0 with none). */
  get consumers(): number {
    return this.acl?.size ?? 0;
  }

  /** Adjudicate one call as this PEP's mode acts on it: {@link decide}, then
   *  (a consult verdict with a principal, and a PDP wired) the policy plane's
   *  answer; enforce then closes what witness only records. `args` are the
   *  call's raw arguments, of which only `action` crosses the wire. */
  async adjudicate(input: Input, args?: unknown): Promise<Decision> {
    const d = await this.consult(decide(this.acl, input), input.verb, args);
    return this.mode === "enforce"
      ? enforced(this.acl, consumerOf(input.peer), d)
      : d;
  }

  /** Put a consult verdict to the PDP, when one is wired and there is a
   *  principal to ask about (a gateway-stamped agent carries its type only). */
  private async consult(
    d: Decision,
    verb: string,
    args: unknown,
  ): Promise<Decision> {
    if (this.pdp === undefined || d.verdict !== "consult" || d.principal === "")
      return d;
    return consulted(
      d,
      await this.pdp.decide({
        principal: d.principal,
        principalType: d.principalType,
        verb,
        star: this.star,
        action: actionOf(args),
      }),
    );
  }

  /** Whether this PEP refuses a call decided as `d`. Witness refuses nothing. */
  refuses(d: Decision): boolean {
    return this.mode === "enforce" && d.verdict !== "allow";
  }

  /** Count one decision, as the `decision` label it was recorded under. */
  count(decision: string, reason: string): void {
    const key = `${this.mode}/${decision}/${reason}`;
    this.tally.set(key, (this.tally.get(key) ?? 0) + 1);
    this.onDecision?.(this.mode, decision, reason);
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
  let acl: Acl | undefined;
  try {
    acl = loadAcl(config.star, path);
  } catch (err) {
    if (err instanceof NoSidecarError && mode === "witness") {
      log(
        `${config.star}: pep: no orbit sidecar at ${path} (${ENV_SIDECAR}); ` +
          "witnessing, every star caller will be recorded would_deny{no_acl}",
      );
      return new Pep(
        config.star,
        mode,
        undefined,
        config.pdp,
        config.onDecision,
      );
    }
    throw new PepBootError(
      `${config.star}: pep: refusing to start, the orbit sidecar at ${path} ` +
        `(${ENV_SIDECAR}) is missing or unparseable: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const pep = new Pep(config.star, mode, acl, config.pdp, config.onDecision);
  if (mode === "enforce") {
    const gaps = enforcePreconditions(acl, pep.hasPdp);
    if (gaps.length > 0) {
      log(
        `${config.star}: pep: ENFORCING with unmet preconditions, the calls they cover are REFUSED: ` +
          gaps.join("; "),
      );
    }
  }
  log(
    `${config.star}: pep: ${mode === "enforce" ? "ENFORCING on" : "witnessing"} inbound calls ` +
      `(mode=${mode} sidecar=${path} consumers=${String(pep.consumers)} pdp=${String(pep.hasPdp)})`,
  );
  return pep;
}
