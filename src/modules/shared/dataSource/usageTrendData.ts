import type { UsageTrendPoint } from "@src/api/tauri/usageDashboard";

const HOUR_MS = 60 * 60 * 1_000;

function emptyTrendPoint(bucketMs: number): UsageTrendPoint {
  return {
    bucketMs,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

/** Fill every UTC-aligned hourly bucket in an inclusive display window. */
export function fillHourlyUsageTrend(
  points: UsageTrendPoint[],
  startMs: number,
  endMs: number
): UsageTrendPoint[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return points;
  }

  const firstBucketMs = Math.floor(startMs / HOUR_MS) * HOUR_MS;
  const lastBucketMs = Math.floor(endMs / HOUR_MS) * HOUR_MS;
  const pointsByBucket = new Map(
    points.map((point) => [point.bucketMs, point] as const)
  );
  const filled: UsageTrendPoint[] = [];

  for (
    let bucketMs = firstBucketMs;
    bucketMs <= lastBucketMs;
    bucketMs += HOUR_MS
  ) {
    filled.push(pointsByBucket.get(bucketMs) ?? emptyTrendPoint(bucketMs));
  }

  return filled;
}
