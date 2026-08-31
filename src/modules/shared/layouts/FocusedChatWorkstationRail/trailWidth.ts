import type { CSSProperties } from "react";

import { WORKSTATION_TRAIL_WIDTH } from "../blocks/WorkstationTrailSurface";

export const WORKSTATION_TRAIL_WIDTH_VARIABLE = "--workstation-trail-width";
export const WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE =
  "--workstation-trail-track-width";
export const WORKSTATION_TRAIL_TERMINAL_WIDTH = 400;
/** The column's px-1 padding reserves 4px on either side. */
export const WORKSTATION_TRAIL_TRACK_PADDING_X = 8;

/**
 * Style payload for the trail column: the trail surface's own width, and the
 * column width that has to contain both it and the terminal.
 *
 * Widths live in custom properties rather than `style.width` because the
 * column only takes a width inside the `@[1100px]/focusedchat` container
 * query — an inline width would also apply below that breakpoint, where the
 * trail must stay at zero and the compact dropdown takes over. Collapsed,
 * the shipped `w-11` class owns the column and both boxes just fill it.
 */
export function resolveTrailWidthVariables(options?: {
  collapsed?: boolean;
  terminalShown?: boolean;
  terminalWidth?: number;
}): CSSProperties {
  if (options?.collapsed) {
    return {
      [WORKSTATION_TRAIL_WIDTH_VARIABLE]: "100%",
      [WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE]: "100%",
    } as CSSProperties;
  }
  const width = WORKSTATION_TRAIL_WIDTH.expandedPx;
  const trackWidth = options?.terminalShown
    ? Math.max(
        width,
        (options.terminalWidth ?? WORKSTATION_TRAIL_TERMINAL_WIDTH) +
          WORKSTATION_TRAIL_TRACK_PADDING_X
      )
    : width;
  return {
    // The trail box itself sits inside the column's inset, exactly as it did
    // when the track was a plain `w-64`.
    [WORKSTATION_TRAIL_WIDTH_VARIABLE]: `${
      width - WORKSTATION_TRAIL_TRACK_PADDING_X
    }px`,
    [WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE]: `${trackWidth}px`,
  } as CSSProperties;
}
