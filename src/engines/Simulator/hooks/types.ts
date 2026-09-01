/**
 * ActivitySimulator Hooks - Type Definitions
 *
 * Shared types for simulator event hooks.
 */
import dayjs from "dayjs";

import type { SessionEvent, SessionSpec } from "@src/engines/SessionCore";

// ============================================
// Hook Options
// ============================================

/** Configuration options for useSimulatorEvents */
export interface UseSimulatorEventsOptions {
  /** Callback when event changes */
  onEventChange?: (event: SessionEvent | null) => void;
  /** Session ID for caching (enables IndexedDB persistence) */
  sessionId?: string;
  /** Enable session caching */
  enableCache?: boolean;
}

// ============================================
// Hook Return Types
// ============================================

/** Return type for useSimulatorEvents */
export interface UseSimulatorEventsReturn {
  // Lightweight timeline and specs
  eventIds: string[];
  specs: SessionSpec[];

  // Current selection
  currentEvent: SessionEvent | null;
  currentEventIndex: number;
  setCurrentEventById: (eventId: string | null) => void;
  setCurrentEventByIndex: (index: number) => void;

  // Replay controls
  replayValue: number;
  setReplayValue: (value: number) => void;
  replayTime: dayjs.Dayjs;
  timeRange: { start: string; end: string };
  isValidTimeRange: boolean;

  // Navigation
  goToStart: () => void;
  goToEnd: () => void;
  goToNext: () => void;
  goToPrevious: () => void;

  // State
  loading: boolean;
  hasRealData: boolean;

  // Cache status for legacy callers; EventStore owns persistence now.
  cacheStatus: CacheStatus;
}

/** Cache status type */
type CacheStatus = "idle" | "loading" | "saving" | "error";

/** Time range info for replay calculations */
export interface TimeRangeInfo {
  isValid: boolean;
  startMs: number;
  endMs: number;
  timeRangeMs: number;
}

// ============================================
// Default Configuration
// ============================================

/** Default options for useSimulatorEvents */
export const DEFAULT_SIMULATOR_OPTIONS: Required<UseSimulatorEventsOptions> = {
  onEventChange: () => {},
  sessionId: "",
  enableCache: true,
};
