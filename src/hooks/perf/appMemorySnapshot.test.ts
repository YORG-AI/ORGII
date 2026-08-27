import { describe, expect, it, vi } from "vitest";

import type { AppMemoryProcess, AppMemorySnapshot } from "./appMemorySnapshot";
import {
  describeAppMemoryMeasurement,
  getAppMemoryMetricKind,
  getAppMemoryTotals,
  refreshAppMemorySnapshot,
} from "./appMemorySnapshot";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

function process(overrides: Partial<AppMemoryProcess>): AppMemoryProcess {
  return {
    pid: 1,
    parent_pid: null,
    process_instance_id: "1:1",
    name: "ORG2 backend",
    role: "backend",
    effective_memory_bytes: 100,
    metric_kind: "physical_footprint",
    rss_bytes: 150,
    resident_private_bytes: 40,
    resident_shared_bytes: 20,
    swapped_bytes: 60,
    breakdown_kind: "vm_region_walk",
    peak_effective_memory_bytes: 200,
    ...overrides,
  };
}

function snapshotWith(
  processes: AppMemoryProcess[],
  overrides: Partial<AppMemorySnapshot> = {}
): AppMemorySnapshot {
  return {
    schema_version: 2,
    captured_at_ms: 123,
    processes,
    effective_total_bytes: processes.reduce(
      (sum, item) => sum + item.effective_memory_bytes,
      0
    ),
    rss_mapped_total_bytes: processes.reduce(
      (sum, item) => sum + item.rss_bytes,
      0
    ),
    resident_private_total_bytes: processes.reduce(
      (sum, item) => sum + item.resident_private_bytes,
      0
    ),
    resident_shared_total_bytes: processes.reduce(
      (sum, item) => sum + item.resident_shared_bytes,
      0
    ),
    swapped_total_bytes: processes.reduce(
      (sum, item) => sum + item.swapped_bytes,
      0
    ),
    measurement: "native",
    attribution: "complete",
    skipped_ambiguous_pids: [],
    ...overrides,
  };
}

const translate = (key: string) => `<${key}>`;

describe("app-memory snapshot store", () => {
  it("derives the top total only from the authoritative app snapshot", () => {
    const snapshot = snapshotWith([
      process({}),
      process({
        pid: 2,
        process_instance_id: "2:2",
        name: "WebView renderer",
        role: "renderer",
        effective_memory_bytes: 50,
        rss_bytes: 75,
        resident_private_bytes: 10,
        resident_shared_bytes: 5,
        swapped_bytes: 40,
      }),
    ]);

    expect(getAppMemoryTotals(snapshot)).toEqual({
      totalBytes: 150,
      backendBytes: 100,
      webviewHelperBytes: 50,
      residentPrivateBytes: 50,
      residentSharedBytes: 25,
      swappedBytes: 100,
      hasBreakdown: true,
    });
  });

  it("reports no breakdown when every process lacks a split", () => {
    const snapshot = snapshotWith([
      process({
        metric_kind: "rss_fallback",
        breakdown_kind: "unavailable",
        resident_private_bytes: 0,
        resident_shared_bytes: 0,
        swapped_bytes: 0,
        peak_effective_memory_bytes: null,
      }),
    ]);
    expect(getAppMemoryTotals(snapshot).hasBreakdown).toBe(false);
    expect(getAppMemoryTotals(null)).toEqual({
      totalBytes: 0,
      backendBytes: 0,
      webviewHelperBytes: 0,
      residentPrivateBytes: 0,
      residentSharedBytes: 0,
      swappedBytes: 0,
      hasBreakdown: false,
    });
  });

  it("uses the backend metric kind as the headline metric", () => {
    const snapshot = snapshotWith([
      process({
        pid: 2,
        role: "renderer",
        metric_kind: "rss_fallback",
      }),
      process({ metric_kind: "private_working_set" }),
    ]);
    expect(getAppMemoryMetricKind(snapshot)).toBe("private_working_set");
    expect(getAppMemoryMetricKind(null)).toBeNull();
    expect(getAppMemoryMetricKind(snapshotWith([]))).toBeNull();
  });

  it("describes the measurement with the OS metric and any caveats", () => {
    expect(
      describeAppMemoryMeasurement(snapshotWith([process({})]), translate)
    ).toBe("<monitor.metricKinds.physical_footprint>");
    expect(
      describeAppMemoryMeasurement(
        snapshotWith([process({})], {
          measurement: "mixed",
          attribution: "partial",
        }),
        translate
      )
    ).toBe(
      "<monitor.metricKinds.physical_footprint> · <monitor.measurementKinds.mixed> · <monitor.attributionPartial>"
    );
    expect(describeAppMemoryMeasurement(null, translate)).toBe(
      "<monitor.measurementKinds.unavailable>"
    );
  });

  it("shares one in-flight native snapshot request across consumers", async () => {
    let resolveRequest!: (snapshot: AppMemorySnapshot) => void;
    const request = new Promise<AppMemorySnapshot>((resolve) => {
      resolveRequest = resolve;
    });
    mocks.invoke.mockReturnValue(request);

    const first = refreshAppMemorySnapshot();
    const second = refreshAppMemorySnapshot();

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("get_app_memory_snapshot_v1");

    const snapshot = snapshotWith([], {
      effective_total_bytes: 456,
      rss_mapped_total_bytes: 789,
      attribution: "partial",
      skipped_ambiguous_pids: [42],
    });
    resolveRequest(snapshot);

    await expect(first).resolves.toBe(snapshot);
    await expect(second).resolves.toBe(snapshot);
  });
});
