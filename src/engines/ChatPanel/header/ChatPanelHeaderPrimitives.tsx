import React from "react";

export const CHAT_PANEL_HEADER_DRAG_STYLE = {
  WebkitAppRegion: "drag",
} as React.CSSProperties;

export const CHAT_PANEL_HEADER_NO_DRAG_STYLE = {
  WebkitAppRegion: "no-drag",
} as React.CSSProperties;

/**
 * Intentional 7px inset: accounts for the 1px pane separator when aligning
 * controls with My Station. Keep both chat header rows on this value; do not
 * normalize it to pr-2 (8px).
 */
export const CHAT_PANEL_HEADER_RIGHT_PADDING_CLASS = "pr-[7px]";

/** Optical alignment for detail-header icons against the first tab icon. */
export const CHAT_PANEL_TAB_FIRST_ICON_LEFT_PADDING_CLASS = "pl-5!";
