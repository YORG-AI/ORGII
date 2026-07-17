/**
 * Chat Item Pipeline — Types & Configuration
 *
 * Shared types for the pipeline that transforms SessionEvent[]
 * into display-ready OptimizedChatItem[] (filtering, grouping, dedup).
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { ActionSummaryCategory } from "./classifiers";

// ============================================
// Chat Item Type Discriminant
// ============================================

export type ChatItemType =
  | "activity"
  | "readFileGroup"
  | "actionSummaryGroup"
  | "activityStackGroup"
  | "threadSelector";

// ============================================
// Output Types
// ============================================

export interface ActionSummaryEntry {
  category: ActionSummaryCategory;
  events: SessionEvent[];
}

/**
 * Pipeline output item. Wraps a SessionEvent with pipeline-computed metadata
 * (grouping, dedup, thread selectors). This is the sole UI-layer type for
 * the chat panel — there is no separate "ChatItem" wrapper.
 */
export interface OptimizedChatItem {
  chunk_id: string;
  type: ChatItemType | string;
  event?: SessionEvent;
  /** For read file groups */
  readFileEvents?: SessionEvent[];
  /** For action summary groups (consecutive exploration tool calls) */
  actionSummaryEntries?: ActionSummaryEntry[];
  /** Flat ordered list of action summary events (preserves original sequence) */
  actionSummaryItems?: {
    category: ActionSummaryCategory;
    event: SessionEvent;
  }[];
  /** True once a following non-summary event has ended this exploration group. */
  actionSummaryClosedByBoundary?: boolean;
  /** For activity stack groups (paginated same-category blocks, e.g. browser) */
  activityStackGroup?: {
    category: string;
    events: SessionEvent[];
    /** True once a following non-matching event has ended this stack. */
    closedByBoundary?: boolean;
  };
  /** For consolidated partial observations */
  consolidatedParts?: number;
  /** Number of consecutive identical errors collapsed into this item (≥2 means repeats were folded) */
  repeatedErrorCount?: number;
  /** Internal layout-only row used to keep a collapsed turn measurable. */
  structuralOnly?: boolean;
  /** Thread selector synthetic data */
  threadSelectorData?: {
    roundNumber: number;
    threads: unknown[];
    threadFirstEventMap: Map<string, string>;
  };
}

export interface ChatHistoryStats {
  totalActivities: number;
  successCount: number;
  failedCount: number;
  pendingCount: number;
  durationSeconds?: number;
}

// ============================================
// Pipeline Options
// ============================================

export interface ChatItemPipelineOptions {
  groupReadFileActivities?: boolean;
  groupActionSummaries?: boolean;
  minActionSummaryToGroup?: number;
  stackBrowserActions?: boolean;
  minBrowserActionsToStack?: number;
  groupTerminalActivities?: boolean;
  minTerminalActivitiesToGroup?: number;
  groupEditActivities?: boolean;
  minEditActivitiesToGroup?: number;
  consolidatePartialObservations?: boolean;
  preFilterEmptyActivities?: boolean;
  minReadFilesToGroup?: number;
  filterManageTodo?: boolean;
  /**
   * Optional predicate to drop events before any grouping. Used by the
   * Agent Desk when a simulator app (e.g. Diff) takes over a class of
   * events so they don't double-render inline in the chat stream.
   */
  shouldSkipEvent?: (event: SessionEvent) => boolean;
}

export const DEFAULT_PIPELINE_OPTIONS: ChatItemPipelineOptions = {
  groupReadFileActivities: true,
  groupActionSummaries: true,
  minActionSummaryToGroup: 2,
  stackBrowserActions: true,
  minBrowserActionsToStack: 3,
  groupTerminalActivities: true,
  minTerminalActivitiesToGroup: 1,
  groupEditActivities: true,
  minEditActivitiesToGroup: 1,
  consolidatePartialObservations: true,
  preFilterEmptyActivities: true,
  minReadFilesToGroup: 2,
  filterManageTodo: false,
};
