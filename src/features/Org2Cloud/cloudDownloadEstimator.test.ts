import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLOUD_DOWNLOAD_GATE_THRESHOLD_MS,
  __DOWNLOAD_ESTIMATOR_INTERNALS,
  decideCloudDownloadGate,
  estimateCloudDownloadMs,
  recordCloudDownloadSample,
} from "./cloudDownloadEstimator";

beforeEach(() => __DOWNLOAD_ESTIMATOR_INTERNALS.reset());
afterEach(() => __DOWNLOAD_ESTIMATOR_INTERNALS.reset());

describe("estimateCloudDownloadMs", () => {
  it("uses the seeded default rate before any samples", () => {
    // 2500 events at 250/s => 10s + 1.5s fixed overhead.
    expect(estimateCloudDownloadMs(2500)).toBe(11_500);
    expect(estimateCloudDownloadMs(0)).toBe(0);
  });

  it("learns from observed transfers via the persisted EMA", () => {
    const before = estimateCloudDownloadMs(10_000);
    // 4450 events in ~12s => much faster than the 250/s default.
    recordCloudDownloadSample(4450, 12_000);
    const after = estimateCloudDownloadMs(10_000);
    expect(after).toBeLessThan(before);
  });

  it("ignores tiny latency-dominated samples", () => {
    const before = estimateCloudDownloadMs(10_000);
    recordCloudDownloadSample(10, 100);
    expect(estimateCloudDownloadMs(10_000)).toBe(before);
  });
});

describe("decideCloudDownloadGate", () => {
  it("gates only when the estimate crosses the threshold", () => {
    // At the default 250/s: threshold 10s minus 1.5s overhead => ~2125 events.
    expect(decideCloudDownloadGate(500).gate).toBe(false);
    expect(decideCloudDownloadGate(50_000).gate).toBe(true);
    expect(decideCloudDownloadGate(50_000).etaMs).toBeGreaterThan(
      CLOUD_DOWNLOAD_GATE_THRESHOLD_MS
    );
  });

  it("never gates an already-covered session (zero pending)", () => {
    expect(decideCloudDownloadGate(0).gate).toBe(false);
  });
});
