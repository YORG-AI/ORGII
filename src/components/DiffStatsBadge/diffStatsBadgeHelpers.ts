/**
 * Named font-size scale for DiffStatsBadge.
 *
 * The diff-stat system standardizes on the arbitrary-literal sizes already used
 * across the diff viewers (`text-[11px]` / `text-[12px]` in `DIFF_STATS`, plus
 * the 13px viewer body size). `inherit` emits no font-size class so the badge
 * keeps whatever size its variant container bakes in (`default`/`compact`/`chat`)
 * or inherits from its parent — this is the default and preserves current
 * rendering for every pre-existing call site.
 */
export type DiffStatsBadgeSize = "inherit" | "xs" | "sm" | "md";
export type DiffStatsBadgeWeight = "normal" | "medium";

export const DIFF_STATS_SIZE_CLASSES: Record<DiffStatsBadgeSize, string> = {
  inherit: "",
  xs: "text-[11px]",
  sm: "text-[12px]",
  md: "text-[13px]",
};

export const DIFF_STATS_WEIGHT_CLASSES: Record<DiffStatsBadgeWeight, string> = {
  normal: "font-normal",
  medium: "font-medium",
};

/**
 * Maps a {@link DiffStatsBadgeSize} to its font-size class. Unknown/undefined
 * sizes fall back to `inherit` (no class), so the badge never silently changes
 * size when given an unexpected value.
 */
export function getDiffStatsSizeClass(size?: DiffStatsBadgeSize): string {
  if (!size) {
    return DIFF_STATS_SIZE_CLASSES.inherit;
  }
  return DIFF_STATS_SIZE_CLASSES[size] ?? DIFF_STATS_SIZE_CLASSES.inherit;
}

/** Maps the named badge weight to a single Tailwind typography token. */
export function getDiffStatsWeightClass(
  weight: DiffStatsBadgeWeight = "medium"
): string {
  return DIFF_STATS_WEIGHT_CLASSES[weight] ?? DIFF_STATS_WEIGHT_CLASSES.medium;
}
