/**
 * Time-range presets for the Usage dashboard. Resolves a preset to an
 * inclusive `[startMs, endMs]` window (epoch ms) passed to the backend.
 */

export type UsageRangePreset = "today" | "24h" | "7d" | "30d" | "all";

export const USAGE_RANGE_PRESETS: readonly UsageRangePreset[] = [
  "today",
  "24h",
  "7d",
  "30d",
  "all",
];

const DAY_MS = 86_400_000;

export interface ResolvedRange {
  startMs: number | null;
  endMs: number | null;
}

/** Resolve a preset against "now". `all` returns an open window (nulls). */
export function resolveUsageRange(
  preset: UsageRangePreset,
  now: number = Date.now()
): ResolvedRange {
  switch (preset) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { startMs: start.getTime(), endMs: now };
    }
    case "24h":
      return { startMs: now - DAY_MS, endMs: now };
    case "7d":
      return { startMs: now - 7 * DAY_MS, endMs: now };
    case "30d":
      return { startMs: now - 30 * DAY_MS, endMs: now };
    case "all":
    default:
      return { startMs: null, endMs: null };
  }
}
