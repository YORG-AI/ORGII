/**
 * ActivitySimulator Hooks - Unified Exports
 *
 * All simulator-related hooks exported from a single entry point.
 */

// Main hook
export { useSimulatorEvents, default } from "./useSimulatorEvents";

// Sub-hooks
export { useEventIndex, getEventById } from "./useEventIndex";
export { useEventNavigation } from "./useEventNavigation";
export { useReplayMode } from "./useReplayMode";
// Grid hooks
export { useGlobalReplay } from "./useGlobalReplay";
export { useGridLayout } from "./useGridLayout";

// Caption bar
export { useCurrentTurnLastAgentMessage } from "./useCurrentTurnLastAgentMessage";
export type { CurrentTurnLastAgentMessage } from "./useCurrentTurnLastAgentMessage";

export {
  extractSubagentSessionTaskTitle,
  isActiveAtTimestamp,
  useActiveSubagentsAtCursor,
  useSubagentSessions,
} from "./useSubagentSessions";
export type { SubagentSession } from "./useSubagentSessions";

// Types
export * from "./types";
