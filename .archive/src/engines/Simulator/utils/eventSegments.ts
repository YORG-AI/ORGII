/**
 * Event Segment Utilities
 *
 * Color mapping and segment calculation for the colored progress bar
 * in grid cells. Groups consecutive events of the same type into segments.
 */
import type { SessionEvent } from "@src/engines/SessionCore";

import type { EventSegment, EventTypeForColor } from "../types/gridTypes";

// ============================================
// Event Type Colors for Progress Bar
// ============================================

export const EVENT_TYPE_COLORS: Record<EventTypeForColor, string> = {
  file: "var(--color-primary-5)", // Blue - file read
  edit: "var(--color-warning-5)", // Yellow/Orange - file edit
  shell: "var(--color-success-5)", // Green - terminal
  assistant: "#8d4eda", // Purple - AI response
  unknown: "var(--color-fill-3)", // Gray - other
};

/** Get event type for color coding (progress bar + subagent header icon heuristics). */
export function getEventTypeForColor(event: SessionEvent): EventTypeForColor {
  const fn = event.functionName.toLowerCase();

  // Check for diff (file edit)
  const result = (event.result || {}) as Record<string, unknown>;
  const output = (result.output || {}) as Record<string, unknown>;
  const success = (output.success || {}) as Record<string, unknown>;
  if (success.diffString || result.diffString) {
    return "edit";
  }

  // File operations
  if (fn.includes("read_file") || fn.includes("read") || fn.includes("file")) {
    return "file";
  }

  // Shell operations
  if (
    fn.includes("shell") ||
    fn.includes("terminal") ||
    fn.includes("bash") ||
    fn.includes("command")
  ) {
    return "shell";
  }

  // Assistant/AI responses
  if (
    fn === "assistant" ||
    fn.includes("chat") ||
    fn.includes("message") ||
    fn.includes("think") ||
    fn.includes("raw")
  ) {
    return "assistant";
  }

  return "unknown";
}

/** Calculate event type segments for progress bar */
export function calculateEventSegments(events: SessionEvent[]): EventSegment[] {
  if (events.length === 0) return [];

  const segments: EventSegment[] = [];
  const segmentWidth = 100 / events.length;

  let currentType: EventTypeForColor | null = null;
  let segmentStart = 0;

  events.forEach((event, idx) => {
    const type = getEventTypeForColor(event);

    if (type !== currentType) {
      // Save previous segment if exists
      if (currentType !== null) {
        segments.push({
          startPercent: segmentStart,
          endPercent: idx * segmentWidth,
          type: currentType,
          color: EVENT_TYPE_COLORS[currentType],
        });
      }
      // Start new segment
      currentType = type;
      segmentStart = idx * segmentWidth;
    }

    // Handle last event
    if (idx === events.length - 1 && currentType !== null) {
      segments.push({
        startPercent: segmentStart,
        endPercent: 100,
        type: currentType,
        color: EVENT_TYPE_COLORS[currentType],
      });
    }
  });

  return segments;
}
