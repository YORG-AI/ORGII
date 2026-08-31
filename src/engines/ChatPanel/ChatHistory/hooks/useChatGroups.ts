/**
 * React adapter for the pure chat-group projection.
 *
 * Grouping, collapse survivor selection, metadata, and index mapping live in
 * `useChatGroupsProjection.ts` so the same algorithm can later run outside
 * React (for example, in a Web Worker).
 */
import { useMemo } from "react";

import {
  type UseChatGroupsOptions,
  type UseChatGroupsReturn,
  projectChatGroups,
} from "./useChatGroupsProjection";

export {
  getUnloadedTurnMeta,
  isTurnCollapseEligible,
  isTurnPreviewItem,
  resolveTurnDefaultCollapsed,
} from "./useChatGroupsProjection";
export type {
  ChatGroupMeta,
  TailTurnPhase,
  UnloadedTurnMeta,
  UseChatGroupsOptions,
  UseChatGroupsReturn,
} from "./useChatGroupsProjection";

export function useChatGroups(
  optimizedChatHistory: Parameters<typeof projectChatGroups>[0],
  options: UseChatGroupsOptions = {}
): UseChatGroupsReturn {
  const {
    collapseOverrides,
    isAgentWorking,
    tailTurnPhase,
    forceCollapseAllTurns,
    disableTurnCollapse,
    allTurnsCollapsed,
    defaultTurnCollapsed,
    turnGrouping,
    isTurnHeaderItem,
    isTurnBoundaryItem,
  } = options;

  const projectionOptions = useMemo<UseChatGroupsOptions>(
    () => ({
      collapseOverrides,
      isAgentWorking,
      tailTurnPhase,
      forceCollapseAllTurns,
      disableTurnCollapse,
      allTurnsCollapsed,
      defaultTurnCollapsed,
      turnGrouping,
      isTurnHeaderItem,
      isTurnBoundaryItem,
    }),
    [
      collapseOverrides,
      isAgentWorking,
      tailTurnPhase,
      forceCollapseAllTurns,
      disableTurnCollapse,
      allTurnsCollapsed,
      defaultTurnCollapsed,
      turnGrouping,
      isTurnHeaderItem,
      isTurnBoundaryItem,
    ]
  );

  return useMemo(
    () => projectChatGroups(optimizedChatHistory, projectionOptions),
    [optimizedChatHistory, projectionOptions]
  );
}
