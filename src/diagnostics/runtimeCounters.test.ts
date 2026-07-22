import { beforeEach, describe, expect, it } from "vitest";

import {
  consumeHttpDiagnosticsSummary,
  consumeRpcDiagnosticsSummary,
  discardRuntimeDiagnosticsCounters,
  recordDiagnosticsRpc,
} from "./runtimeCounters";

describe("runtime diagnostics counters", () => {
  beforeEach(() => {
    consumeRpcDiagnosticsSummary();
    consumeHttpDiagnosticsSummary();
  });

  it("reports average, p95, and failures from a fixed histogram", () => {
    for (let index = 0; index < 95; index += 1) {
      recordDiagnosticsRpc("fast", 4, true);
    }
    for (let index = 0; index < 5; index += 1) {
      recordDiagnosticsRpc("fast", 600, index !== 4);
    }

    const summary = consumeRpcDiagnosticsSummary();

    expect(summary).toMatchObject({ total: 100, success: 99, failure: 1 });
    expect(summary.byOperation.fast).toEqual({
      total: 100,
      success: 99,
      failure: 1,
      averageDurationBucket: "20_100ms",
      p95DurationBucket: "1_5ms",
    });
  });

  it("keeps at most 128 operation entries and merges overflow", () => {
    for (let index = 0; index < 1_000; index += 1) {
      recordDiagnosticsRpc(`operation-${index}`, index % 10, index % 11 !== 0);
    }

    const summary = consumeRpcDiagnosticsSummary();
    const operations = Object.keys(summary.byOperation);

    expect(operations).toHaveLength(128);
    expect(summary.byOperation.__other__).toMatchObject({
      total: 873,
      failure: 79,
    });
  });

  it("consumes and releases the current interval", () => {
    recordDiagnosticsRpc("one", 1, false);
    expect(consumeRpcDiagnosticsSummary().total).toBe(1);
    expect(consumeRpcDiagnosticsSummary()).toEqual({
      total: 0,
      success: 0,
      failure: 0,
      byOperation: {},
    });
  });

  it("discards bounded counters while diagnostics cannot upload", () => {
    recordDiagnosticsRpc("offline", 2_500, true);
    discardRuntimeDiagnosticsCounters();

    expect(consumeRpcDiagnosticsSummary().total).toBe(0);
  });
});
