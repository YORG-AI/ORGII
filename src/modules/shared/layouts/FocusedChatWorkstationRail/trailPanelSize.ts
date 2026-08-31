export interface TrailPanelSize {
  width: number;
  height: number;
}

export const TRAIL_TERMINAL_SIZE_LIMITS = {
  // Fits the title, scrollable tabs, and process controls in one row.
  minWidth: 320,
  maxWidth: 720,
  minHeight: 120,
  maxHeight: 720,
  defaultHeight: 260,
} as const;

export function clampPanelDimension(value: number, min: number, max: number) {
  return Math.round(Math.max(0, Math.min(max, Math.max(min, value))));
}

export function resizeTrailPanel(
  start: TrailPanelSize,
  delta: TrailPanelSize,
  min: TrailPanelSize,
  max: TrailPanelSize
): TrailPanelSize {
  return {
    // The top/right edges stay anchored: left grows width, down grows height.
    width: clampPanelDimension(start.width - delta.width, min.width, max.width),
    height: clampPanelDimension(
      start.height + delta.height,
      min.height,
      max.height
    ),
  };
}
