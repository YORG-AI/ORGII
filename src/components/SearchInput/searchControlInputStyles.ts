import type { CSSProperties } from "react";

// ─── Shared wrapper class strings ────────────────────────────────────────────

const WRAPPER_FOCUS =
  "transition-[border-color,box-shadow] duration-150 focus-within:border-primary-6 focus-within:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)] [&:not(:focus-within):hover]:border-border-3";

const WRAPPER_BASE =
  "flex h-[28px] min-w-0 flex-1 items-center rounded-lg border border-border-2 bg-bg-2";

export const SEARCH_WRAPPER_PANE_INPUT = "bg-pane-input";

/**
 * Ghost surface — transparent at rest, with a reserved transparent border so
 * focus never shifts the input contents. Hover uses the shared fill-2 tier.
 */
export const SEARCH_WRAPPER_GHOST =
  "border-transparent! bg-transparent! focus-within:border-primary-6! focus-within:bg-pane-input! [&:not(:focus-within):hover]:border-transparent! [&:not(:focus-within):hover]:bg-fill-2!";

/** Panel variant (px-3) — used by SearchInput panel / ReplaceInput panel */
export const SEARCH_WRAPPER_PANEL = `${WRAPPER_BASE} gap-1.5 px-3 ${WRAPPER_FOCUS}`;

/** Sidebar variant (px-2) — used by SearchInput sidebar / ReplaceInput sidebar / SearchFilters */
export const SEARCH_WRAPPER_SIDEBAR = `${WRAPPER_BASE} gap-1.5 px-2 ${WRAPPER_FOCUS}`;

/**
 * Multiline variant: swap the fixed h-[28px] for min-h-[28px] so the box can grow,
 * and top-align children instead of centering — otherwise, as the textarea grows
 * past one line, flex re-centers everything (text + icon buttons) in the middle of
 * the whole box instead of holding the first row in place. `SEARCH_ROW_TOP_OFFSET_PX`
 * below restores the single-line centered look on top of this top alignment.
 */
export function searchWrapperMultiline(base: string): string {
  return base
    .replace("h-[28px]", "min-h-[28px]")
    .replace("items-center", "items-start");
}

// ─── Input element inline styles ─────────────────────────────────────────────

/** Row height every search/replace control is built around. */
export const SEARCH_ROW_HEIGHT_PX = 28;

const MULTILINE_FONT_SIZE_PX = 14;
const MULTILINE_LINE_HEIGHT = 1.4;

/**
 * Top offset that makes a single line of multiline text (or an icon button) sit
 * vertically centered within the first SEARCH_ROW_HEIGHT_PX of a top-aligned,
 * height:auto row. Apply it as padding-top on the textarea and as margin-top on
 * the row's icon buttons so both stay pinned to the same "row one" position —
 * centered when there's one line, fixed in place (not re-centering) once the
 * textarea grows to multiple lines.
 */
export const SEARCH_ROW_TOP_OFFSET_PX =
  (SEARCH_ROW_HEIGHT_PX - MULTILINE_FONT_SIZE_PX * MULTILINE_LINE_HEIGHT) / 2;

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

/**
 * Inline styles for the <textarea> used when `multiline` is set. Height grows
 * with content (`rows={1}` + JS auto-resize), so unlike the single-line <input>
 * we can't center via line-height alone — `paddingTop: SEARCH_ROW_TOP_OFFSET_PX`
 * centers the first line within the row instead, and stays put as more lines wrap in.
 */
export function searchControlMultilineInputStyle(
  fontSizePx: number
): CSSProperties {
  return {
    display: "block",
    width: "100%",
    height: "auto",
    padding: 0,
    paddingTop: SEARCH_ROW_TOP_OFFSET_PX,
    margin: 0,
    border: "none",
    outline: "none",
    background: "transparent",
    boxShadow: "none",
    fontSize: fontSizePx,
    lineHeight: MULTILINE_LINE_HEIGHT,
    appearance: "none",
    WebkitAppearance: "none",
    boxSizing: "border-box",
    resize: "none",
  };
}
