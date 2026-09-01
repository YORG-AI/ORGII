/**
 * Chat Item Pipeline
 *
 * Transforms SessionEvent[] into display-ready OptimizedChatItem[]:
 * filtering, dedup, grouping.
 *
 * @module chatItemPipeline
 */

// Main pipeline
export { processChatItems } from "./pipeline";

// Types
export type {
  ActionSummaryEntry,
  ChatHistoryStats,
  ChatItemPipelineOptions,
  ChatPipelineSkipPolicy,
  OptimizedChatItem,
} from "./types";

// Filters (used by ChatItemRenderer)
export { willEventRenderContent } from "./filters";

// Utils
export { calculateDuration } from "./utils";
