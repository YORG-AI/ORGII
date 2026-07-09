/**
 * Shared types for the ContextInfoButton sub-component tree.
 */

export type RingTone = "unused" | "normal" | "warning" | "critical";

/** Stroke color for each ring tone. */
export const RING_TONE_STROKE: Record<RingTone, string> = {
  unused: "stroke-text-4",
  normal: "stroke-blue-500",
  warning: "stroke-yellow-500",
  critical: "stroke-red-500",
};

/**
 * Determine ring tone from the real (unclamped) percentage.
 *
 * The comfort zone is deliberately wide. ORGII auto-compacts older context
 * around the budget's ~80% mark, so the window never actually overflows in
 * normal use - a calm blue ring for the vast majority of a session is the
 * honest signal. Yellow only appears as we approach that auto-compaction
 * point (a "ORGII will tidy up" hint, not "about to fail"), and red is
 * reserved for a genuine, rare overflow past 100%.
 */
export function ringToneForPercentage(pct: number): RingTone {
  if (pct <= 0) return "unused";
  if (pct < 90) return "normal";
  if (pct <= 100) return "warning";
  return "critical";
}

export interface PanelCategory {
  key: string;
  label: string;
  tokens: number;
  percent: number;
  hex: string;
}

export interface PanelPosition {
  bottom: number;
  right: number;
}

// Ring geometry constants - used by both ProgressRing and useContextPanel.
export const RING_SIZE = 14;
export const RING_STROKE = 1.75;
export const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// Panel positioning constants.
export const PANEL_GAP = 8;
export const PANEL_WIDTH = 320;
export const VIEWPORT_PADDING = 8;
