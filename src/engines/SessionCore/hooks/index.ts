/**
 * Session Hooks Module
 *
 * Organized by functionality:
 * - session/: Session lifecycle (create, discover, manage)
 * - replay/: Replay navigation, step state, file tracking
 * - hostedKey/: Hosted-key (ORGII key) sync utilities
 * - useSessionStore: Main state consumption hook
 */

// ============================================
// Store Hooks (main entry point)
// ============================================

export {
  useCurrentEvent,
  useEventNavigation,
  useReplayBar,
  useSessionStore,
  useSimulatorEvents,
} from "./useSessionStore";

export type { UseSessionStoreReturn } from "./useSessionStore";

// ============================================
// Session Management (session/)
// ============================================

export {
  useSessionManager,
  useSessionDiscovery,
  useSessionCreator,
} from "./session";

export type { UseSessionCreatorReturn } from "./session";

// ============================================
// Replay & Navigation (replay/)
// ============================================

export {
  // Replay state
  useReplayBarState,
  useReplayState,
  useReplayTime,
  // Step state
  useStepState,
  // File tracking
  useRecentFiles,
  useRecentFilesForEvent,
  // Planning indicator
  usePlanningIndicator,
} from "./replay";

export type {
  UseReplayStateReturn,
  WpTimeRange,
  UseStepStateReturn,
  UseRecentFilesReturn,
  PlanningIndicatorState,
} from "./replay";

// ============================================
// Hosted Key Sync (hostedKey/)
// ============================================

export { useHostedKeyActivitySync } from "./hostedKey";

// ============================================
// Streaming delta (per-session selector)
// ============================================

export { useStreamingDeltaForSession } from "./useStreamingDeltaForSession";
