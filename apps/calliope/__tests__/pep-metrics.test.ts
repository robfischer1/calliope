import { describe, expect, it } from "vitest";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  DECISIONS_METRIC,
  metricsConfigured,
  startPepMetrics,
} from "../src/mcp/pep/metrics.js";

/** The OTLP counter carries Go's `stellar_pep_decisions_total{mode,decision,reason}`. */

describe("stellar_pep_decisions_total", () => {
  it("is named and labelled as Go's, with the SDK resource", async () => {
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    );
    const m = startPepMetrics(
      "calliope",
      { OTEL_SERVICE_NAME: "calliope" },
      exporter,
    );
    m.record("witness", "would_consult", "pdp_not_consulted");
    m.record("witness", "would_consult", "pdp_not_consulted");
    m.record("enforce", "deny", "pdp_error");
    await m.shutdown(); // final collection exports to the in-memory exporter
    const rm = exporter.getMetrics();
    const last = rm[rm.length - 1];
    expect(last?.resource.attributes["service.name"]).toBe("calliope");
    expect(last?.resource.attributes["telemetry.sdk.name"]).toBeDefined();
    const metric = last?.scopeMetrics[0]?.metrics[0];
    expect(metric?.descriptor.name).toBe(DECISIONS_METRIC);
    expect(DECISIONS_METRIC).toBe("stellar_pep_decisions_total");
    const points = (metric?.dataPoints ?? []).map((p) => [
      p.attributes,
      p.value,
    ]);
    expect(points).toEqual(
      expect.arrayContaining([
        [
          {
            mode: "witness",
            decision: "would_consult",
            reason: "pdp_not_consulted",
          },
          2,
        ],
        [{ mode: "enforce", decision: "deny", reason: "pdp_error" }, 1],
      ]),
    );
    expect(points).toHaveLength(2);
  });

  it("exports nothing without a destination, or when declined", () => {
    expect(metricsConfigured({})).toBe(false);
    expect(
      metricsConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" }),
    ).toBe(true);
    expect(
      metricsConfigured({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
        OTEL_SDK_DISABLED: "TRUE",
      }),
    ).toBe(false);
    expect(
      metricsConfigured({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
        OTEL_METRICS_EXPORTER: "none",
      }),
    ).toBe(false);
    const off = startPepMetrics("calliope", {});
    expect(() => {
      off.record("witness", "allow", "edge_allows");
    }).not.toThrow();
  });
});
