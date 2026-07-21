import { describe, expect, it } from "vitest";

import type { UsageTrendPoint } from "@src/api/tauri/usageDashboard";

import { fillHourlyUsageTrend } from "./usageTrendData";

const HOUR_MS = 60 * 60 * 1_000;

function trendPoint(bucketMs: number): UsageTrendPoint {
  return {
    bucketMs,
    inputTokens: 12,
    outputTokens: 3,
    cacheReadTokens: 5,
    cacheWriteTokens: 2,
    costUsd: 0.25,
  };
}

describe("fillHourlyUsageTrend", () => {
  it("returns all 24 buckets for a full-day display window", () => {
    const startMs = Date.UTC(2026, 6, 20);
    const existing = trendPoint(startMs + 3 * HOUR_MS);

    const result = fillHourlyUsageTrend(
      [existing],
      startMs,
      startMs + 24 * HOUR_MS - 1
    );

    expect(result).toHaveLength(24);
    expect(result[0]).toEqual({
      bucketMs: startMs,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    });
    expect(result[3]).toBe(existing);
    expect(result[23]?.bucketMs).toBe(startMs + 23 * HOUR_MS);
  });

  it("fills gaps between partial-window boundary buckets", () => {
    const startMs = Date.UTC(2026, 6, 20, 10, 30);
    const endMs = Date.UTC(2026, 6, 20, 13, 15);

    const result = fillHourlyUsageTrend(
      [trendPoint(Date.UTC(2026, 6, 20, 12))],
      startMs,
      endMs
    );

    expect(result.map((point) => point.bucketMs)).toEqual([
      Date.UTC(2026, 6, 20, 10),
      Date.UTC(2026, 6, 20, 11),
      Date.UTC(2026, 6, 20, 12),
      Date.UTC(2026, 6, 20, 13),
    ]);
    expect(result.map((point) => point.inputTokens)).toEqual([0, 0, 12, 0]);
  });

  it("leaves data unchanged for an invalid window", () => {
    const points = [trendPoint(Date.UTC(2026, 6, 20, 12))];

    expect(fillHourlyUsageTrend(points, 2, 1)).toBe(points);
  });
});
