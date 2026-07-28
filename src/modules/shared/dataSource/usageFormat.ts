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

const AXIS_UNITS = [
  { threshold: 1e9, divisor: 1e9, suffix: "B" },
  { threshold: 1e6, divisor: 1e6, suffix: "M" },
  { threshold: 1e3, divisor: 1e3, suffix: "K" },
] as const;

/** Drop trailing zeros: `700.00` → `700`, `4.05` → `4.05`. */
function trimmed(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

/**
 * Axis-tick token count: `999`, `1.2K`, `700M`, `4.05B`.
 *
 * Same K/M/B scale as {@link formatTokensShort}, but precision shrinks as the
 * mantissa grows so a label never exceeds ~5 characters. The fixed two
 * decimals of `formatTokensShort` overflow the width reserved by the Y axis
 * once ticks reach hundreds of millions, and SVG clips the overflow — which
 * rendered `700.00M` as `00.00M`.
 */
export function formatTokensAxis(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const unit = AXIS_UNITS.find((candidate) => value >= candidate.threshold);
  if (!unit) return trimmed(value, 0);
  const scaled = value / unit.divisor;
  return `${trimmed(scaled, scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)}${unit.suffix}`;
}

/** USD with a fixed number of decimals. Non-finite → `$0`. */
export function formatUsd(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return "$0";
  return `$${value.toFixed(digits)}`;
}

/**
 * Axis-tick USD: `$0`, `$0.25`, `$12`, `$800`, `$1.3K`.
 *
 * Bounded like {@link formatTokensAxis} — a raw `$${value}` tick prints every
 * digit of a non-round domain (`$1250.5`, `$0.30000000000000004`) and gets
 * clipped by the axis width.
 */
export function formatUsdAxis(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e3) {
    return `$${trimmed(value / 1e3, magnitude >= 1e4 ? 0 : 1)}K`;
  }
  if (magnitude >= 10) return `$${trimmed(value, 0)}`;
  if (magnitude >= 1) return `$${trimmed(value, 1)}`;
  return `$${trimmed(value, 2)}`;
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
