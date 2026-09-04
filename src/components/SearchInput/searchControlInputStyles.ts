import type { CSSProperties } from "react";

// ─── Shared wrapper class strings ────────────────────────────────────────────

const WRAPPER_FOCUS =
  "transition-[border-color,box-shadow] duration-150 focus-within:border-primary-6 focus-within:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)] [&:not(:focus-within):hover]:border-border-3";

const WRAPPER_BASE =
  "flex h-[28px] min-w-0 flex-1 items-center rounded-lg border border-border-2 bg-bg-2";

export const SEARCH_WRAPPER_PANE_INPUT = "bg-pane-input";

/** Ghost surface — transparent at rest, restoring the regular field on focus. */
export const SEARCH_WRAPPER_GHOST =
  "border-0! bg-transparent! focus-within:border! focus-within:border-primary-6! focus-within:bg-pane-input! [&:not(:focus-within):hover]:border-0! [&:not(:focus-within):hover]:bg-surface-hover";

/** Panel variant (px-3) — used by SearchInput panel / ReplaceInput panel */
export const SEARCH_WRAPPER_PANEL = `${WRAPPER_BASE} gap-1.5 px-3 ${WRAPPER_FOCUS}`;

/** Sidebar variant (px-2) — used by SearchInput sidebar / ReplaceInput sidebar / SearchFilters */
export const SEARCH_WRAPPER_SIDEBAR = `${WRAPPER_BASE} gap-1.5 px-2 ${WRAPPER_FOCUS}`;

/** Multiline variant: swap the fixed h-[28px] for min-h-[28px] so the box can grow */
export function searchWrapperMultiline(base: string): string {
  return base.replace("h-[28px]", "min-h-[28px]");
}

// ─── Input element inline styles ─────────────────────────────────────────────

/**
 * Inline styles for a plain <input> inside a 28px search row.
 * The input fills the row and uses a matching line-height so single-line text and
 * placeholders sit on the visual vertical center instead of relying on browser defaults.
 */
export function searchControlSingleLineInputStyle(
  fontSizePx: number
): CSSProperties {
  return {
    display: "block",
    height: "28px",
    padding: 0,
    margin: 0,
    border: "none",
    outline: "none",
    background: "transparent",
    boxShadow: "none",
    fontSize: fontSizePx,
    lineHeight: "28px",
    appearance: "none",
    WebkitAppearance: "none",
    boxSizing: "border-box",
  };
}
