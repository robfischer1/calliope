/**
 * The PEP's decision counter on OpenTelemetry. The TS peer of stellar-core-go's
 * `stellar_pep_decisions_total{mode,decision,reason}`, which Go exposes on a
 * prometheus registry bridged onto OTLP. stellar-core-ts's sender is traces
 * only (telemetry.ts: "Metrics and logs remain deferred for TS"), so this is
 * the minimal metrics pipeline: one MeterProvider, one periodic OTLP reader,
 * one counter. It reads the same standard OTEL_* environment the trace sender
 * does, and the same kill switches: no destination, `OTEL_SDK_DISABLED=true` or
 * `OTEL_METRICS_EXPORTER=none` means no export (the counter is then a no-op).
 */

import type { Counter, Meter } from "@opentelemetry/api";
import { OTLPMetricExporter as JsonExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as ProtoExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";

/** The counter the fleet alerts on (Go `policy.DecisionsMetric`). */
export const DECISIONS_METRIC = "stellar_pep_decisions_total";

/** Records one decision under the Go label set. */
export type DecisionRecorder = (
  mode: string,
  decision: string,
  reason: string,
) => void;

type Env = Record<string, string | undefined>;

const first = (...v: (string | undefined)[]): string =>
  v.map((x) => x?.trim() ?? "").find((x) => x !== "") ?? "";

/** Whether the environment asks for OTLP metric export to somewhere. */
export function metricsConfigured(env: Env): boolean {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return false;
  const names = (env.OTEL_METRICS_EXPORTER ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n !== "");
  if (names.length > 0) return names.includes("otlp");
  return (
    first(
      env.OTEL_EXPORTER_OTLP_ENDPOINT,
      env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    ) !== ""
  );
}

/** The exporter class the protocol env picks (spec default http/protobuf). */
export function metricExporterFromEnv(env: Env): PushMetricExporter {
  const proto = first(
    env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL,
    env.OTEL_EXPORTER_OTLP_PROTOCOL,
  ).toLowerCase();
  return proto === "http/json" ? new JsonExporter() : new ProtoExporter();
}

/** The counter on `meter`, as a {@link DecisionRecorder}. */
export function decisionRecorder(meter: Meter): DecisionRecorder {
  const counter: Counter = meter.createCounter(DECISIONS_METRIC, {
    description:
      "Endpoint PEP decisions on inbound tools/call. In witness mode nothing is refused: " +
      "would_deny is what enforce would refuse, would_consult what it would ask the policy plane.",
  });
  return (mode, decision, reason) => {
    counter.add(1, { mode, decision, reason });
  };
}

export interface PepMetrics {
  readonly record: DecisionRecorder;
  /** Flush and stop; always callable. */
  readonly shutdown: () => Promise<void>;
}

const NOOP: PepMetrics = {
  record: () => undefined,
  shutdown: () => Promise.resolve(),
};

/**
 * Start the metrics pipeline for `service`, or a no-op when the environment
 * declines or names no destination. The resource carries `service.name` and
 * the SDK's own `telemetry.sdk.*`, so the series match the other stars'.
 */
export function startPepMetrics(
  service: string,
  env: Env = process.env,
  exporter?: PushMetricExporter,
): PepMetrics {
  if (exporter === undefined && !metricsConfigured(env)) return NOOP;
  const resource = defaultResource().merge(
    resourceFromAttributes({
      "service.name": env.OTEL_SERVICE_NAME ?? service,
      ...(env.OTEL_SERVICE_VERSION === undefined
        ? {}
        : { "service.version": env.OTEL_SERVICE_VERSION }),
      ...(first(env.STELLAR_REALM) === ""
        ? {}
        : { "stellar.realm": first(env.STELLAR_REALM) }),
    }),
  );
  const interval = Number(env.OTEL_METRIC_EXPORT_INTERVAL);
  const provider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: exporter ?? metricExporterFromEnv(env),
        exportIntervalMillis: interval > 0 ? interval : 60_000,
      }),
    ],
  });
  return {
    record: decisionRecorder(provider.getMeter("@forge/calliope/pep")),
    shutdown: () => provider.shutdown(),
  };
}
