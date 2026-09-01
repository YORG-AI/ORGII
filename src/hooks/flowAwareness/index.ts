/**
 * Flow Awareness hooks for user activity tracking.
 *
 * This module provides hooks to track user activities for intent inference
 * by the agent system. Activities are recorded and aggregated to provide
 * context about what the user is currently doing.
 *
 * @example
 * ```tsx
 * import { useFlowAwareness, useGlobalFlowTracker } from "@src/hooks/flowAwareness";
 *
 * // In a component that needs to record activities
 * const { recordFileEdit, recordSearch } = useFlowAwareness();
 *
 * // At the app root to enable global tracking
 * useGlobalFlowTracker();
 * ```
 */

export { useFlowAwareness } from "./useFlowAwareness";

export type {
  // Core types
  ActivityType,
  FileEditType,
  SearchScope,
  ClipboardOp,
  GitOpType,
  NavigationTarget,
  ErrorType,
  DebugAction,

  // Interface types
  ActivityInput,
  FlowSummary,
  UseFlowAwarenessOptions,
  UseFlowAwarenessReturn,
} from "./types";

export { useGlobalFlowTracker } from "./useGlobalFlowTracker";

export { FLOW_AWARENESS_CONFIG } from "./config";
