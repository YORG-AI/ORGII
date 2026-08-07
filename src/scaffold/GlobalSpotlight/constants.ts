/**
 * GlobalSpotlight Constants
 *
 * Centralized config for spotlight positioning and limits. All spotlight
 * chrome lives in SpotlightShell — constants here are the single source of
 * truth it reads from.
 */

export const SPOTLIGHT_CONFIG = {
  /** Width of the spotlight in pixels */
  width: 680,
  /** Distance from top of viewport in pixels */
  topOffset: 8,
  /** Z-index for backdrop overlay */
  backdropZIndex: 9998,
  /** Z-index for spotlight container */
  containerZIndex: 9999,
} as const;

// ============ TYPOGRAPHY TOKENS ============

export const SPOTLIGHT_TOKENS = {
  /** Input / pill text */
  inputFontSize: "text-[14px]",
  /** Primary item label */
  labelFontSize: "text-[14px]",
  /** Secondary / desc / subtitle text */
  subFontSize: "text-[11px]",
  /** Badge / tag text */
  badgeFontSize: "text-[10px]",
  /** Item row height (no desc) */
  itemHeight: 34,
  /** Item row height (with desc line) */
  itemHeightWithDesc: 48,
  /** Icon size inside item rows */
  iconSize: 16,
} as const;

export const SPOTLIGHT_CLASSES = {
  /** Primary contextual pill used by palette navigation and active state badges. */
  primaryPill:
    "flex items-center gap-1 rounded-full bg-primary-1 px-2.5 py-1 text-primary-6",
} as const;

// ============ LIMITS ============

export const LIMITS = {
  pageSize: 25,
  quickActionsMax: 25,
  unifiedSearchMax: 25,
  scrollThreshold: 100,
};
