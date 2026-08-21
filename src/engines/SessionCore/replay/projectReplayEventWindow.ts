import type { ReplayPhase } from "./replayController";

export interface ReplayEventWindow {
  endIndex: number;
  /** When true, consumers may use the full `events` array without slicing. */
  isFullWindow: boolean;
}

export function resolveReplayEventWindow(
  eventCount: number,
  phase: ReplayPhase,
  index: number
): ReplayEventWindow {
  if (eventCount <= 0) {
    return { endIndex: -1, isFullWindow: true };
  }
  if (phase === "follow") {
    return { endIndex: eventCount - 1, isFullWindow: true };
  }
  const lastIndex = eventCount - 1;
  return {
    endIndex: Math.min(Math.max(index, 0), lastIndex),
    isFullWindow: false,
  };
}

export function projectReplayVisibleEvents<T>(
  events: readonly T[],
  window: ReplayEventWindow
): readonly T[] {
  if (events.length === 0 || window.isFullWindow) {
    return events;
  }
  if (window.endIndex < 0) {
    return events.slice(0, 0);
  }
  return events.slice(0, window.endIndex + 1);
}
