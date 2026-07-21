/**
 * Formatting + time-range helpers for the Usage dashboard.
 *
 * Token counts reach hundreds of millions / billions, so use compact K/M/B
 * consistently across every locale (no 万/亿) for a single readable scale.
 */

/** Compact token count: `999`, `1.2K`, `540M`, `5.36B` — always K/M/B. */
export function formatTokensShort(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toLocaleString("en-US");
}

/** USD with a fixed number of decimals. Non-finite → `$0`. */
export function formatUsd(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return "$0";
  return `$${value.toFixed(digits)}`;
}

/** Ratio in 0–1 rendered as a whole-number percent. */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${(value * 100).toFixed(1)}%`;
}

/** Full-precision integer with thousands separators. */
export function formatInt(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(locale).format(Math.trunc(value));
}

/** Compact hour label for Today / 24h chart axes: `2AM`, `12PM`. */
export function formatCompactHour(date: Date): string {
  const hour = date.getHours();
  const hour12 = hour % 12 || 12;
  return `${hour12}${hour < 12 ? "AM" : "PM"}`;
}

/**
 * cc-switch-style cache breakdown shown under a fresh-input value:
 * `R777,380·W40` (read · write), full comma integers. Empty when no cache.
 */
export function formatCacheRW(cacheRead: number, cacheWrite: number): string {
  const parts: string[] = [];
  if (cacheRead > 0) parts.push(`R${formatInt(cacheRead)}`);
  if (cacheWrite > 0) parts.push(`W${formatInt(cacheWrite)}`);
  return parts.join("·");
}
