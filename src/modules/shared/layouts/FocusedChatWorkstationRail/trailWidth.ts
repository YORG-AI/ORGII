/**
 * Workstation trail width model.
 *
 * The trail used to be a two-state track (256px expanded / 44px collapsed)
 * driven purely by responsive Tailwind classes. It is now continuously
 * resizable while expanded, so the expanded track reads its width from the
 * `--workstation-trail-width` custom property this module produces.
 *
 * Two persisted numbers drive it:
 *   - `width`     — the current expanded width.
 *   - `minWidth`  — the user's own floor, set from the context menu's
 *                   "set current width as minimum". Drag and the width
 *                   clamp both respect it, so a trail the user decided is
 *                   as narrow as it should get can never be dragged past
 *                   that point.
 *
 * `FLOOR` is the hard lower bound a user-set minimum itself is clamped to:
 * below it the trail rows stop being readable and the collapsed track is
 * the better control.
 */
import type { CSSProperties } from "react";

export const WORKSTATION_TRAIL_WIDTH_LIMITS = {
  /** Shipped width, and the target of "restore original width". */
  default: 256,
  /** Hard lower bound for both the width and a user-set minimum. */
  floor: 220,
  /** Hard upper bound; the chat column keeps its own min width on top. */
  max: 520,
  /** How much one "wider" step grows the trail. */
  step: 48,
} as const;

/** Width of the trail surface itself. */
export const WORKSTATION_TRAIL_WIDTH_VARIABLE = "--workstation-trail-width";
/** Width of the whole trail column, which the terminal can widen on its own. */
export const WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE =
  "--workstation-trail-track-width";

/**
 * Width of the docked terminal. It is the terminal's own width, not the
 * trail's: a 256px trail is fine to read but too narrow for a shell, so the
 * terminal takes this width and the trail above it keeps whatever width the
 * user gave it. The column is as wide as the wider of the two.
 */
export const WORKSTATION_TRAIL_TERMINAL_WIDTH = 400;

/**
 * Horizontal inset the column reserves so neither box touches the pane edge
 * — `FOCUSED_CHAT_WORKSTATION_TRAIL_RAIL_PADDING_CLASS`'s `px-1`, 4px a side.
 *
 * Widths in this module are *column* widths, matching the `w-64` the track
 * used to carry: the boxes inside are that much narrower, because the column
 * is `box-sizing: border-box` and the padding comes out of its width.
 */
export const WORKSTATION_TRAIL_TRACK_PADDING_X = 8;

/**
 * Clamp a user-set minimum into `[floor, max]`.
 *
 * The minimum is allowed above the shipped default: "set current width as
 * minimum" pins whatever the trail is at right now, including a width the
 * user dragged past 256px. It never moves the current width — see
 * `clampTrailWidth`, which is only applied to widths the user is actively
 * changing.
 */
export function resolveTrailMinWidth(storedMinWidth: number | null): number {
  if (storedMinWidth == null || !Number.isFinite(storedMinWidth)) {
    return WORKSTATION_TRAIL_WIDTH_LIMITS.floor;
  }
  return Math.min(
    WORKSTATION_TRAIL_WIDTH_LIMITS.max,
    Math.max(WORKSTATION_TRAIL_WIDTH_LIMITS.floor, Math.round(storedMinWidth))
  );
}

/** Clamp a width into `[minWidth, max]`, falling back to the default. */
export function clampTrailWidth(
  width: number | null,
  minWidth: number
): number {
  if (width == null || !Number.isFinite(width)) {
    return Math.max(minWidth, WORKSTATION_TRAIL_WIDTH_LIMITS.default);
  }
  return Math.min(
    WORKSTATION_TRAIL_WIDTH_LIMITS.max,
    Math.max(minWidth, Math.round(width))
  );
}

/**
 * Next width one "wider" step up, clamped to the maximum. Returns the same
 * width when the trail is already at the maximum, which the menu reads as
 * "disable this item".
 */
export function resolveNextWiderTrailWidth(
  width: number,
  minWidth: number
): number {
  return clampTrailWidth(width + WORKSTATION_TRAIL_WIDTH_LIMITS.step, minWidth);
}

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
export function resolveTrailWidthVariables(
  width: number,
  options?: { collapsed?: boolean; terminalShown?: boolean }
): CSSProperties {
  if (options?.collapsed) {
    return {
      [WORKSTATION_TRAIL_WIDTH_VARIABLE]: "100%",
      [WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE]: "100%",
    } as CSSProperties;
  }
  const trackWidth = options?.terminalShown
    ? Math.max(
        width,
        WORKSTATION_TRAIL_TERMINAL_WIDTH + WORKSTATION_TRAIL_TRACK_PADDING_X
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
