/**
 * useGroupHeaderRenderer
 *
 * Builds the memoized `renderGroupHeader` function passed into
 * the chat history list. Centralizes the dependency list so ChatHistory's
 * top-level body stays focused on orchestration.
 */
import React, { useCallback } from "react";

import type { OptimizedChatItem } from "../chatItemPipeline/types";
import { GroupHeaderRenderer } from "../renderers";
import type {
  GroupHeaderRenderPart,
  GroupHeaderRendererProps,
} from "../renderers/GroupHeaderRenderer";
import type { ChatGroupMeta } from "./useChatGroups";

interface UseGroupHeaderRendererOptions {
  displaySourceGroupIndices: number[];
  sourceGroupCount: number;
  displayGroupHeaders: (OptimizedChatItem | null)[];
  displayGroupMeta: ChatGroupMeta[];
  displayGroupCount: number;
  collapseLabelVariant?: GroupHeaderRendererProps["collapseLabelVariant"];
  turnPaginationEnabled: boolean;
  tailTurnPhase: GroupHeaderRendererProps["tailTurnPhase"];
  hideUserMessage: boolean;
  defaultTurnCollapsed: boolean;
  turnCollapseInteractionAtRef: React.MutableRefObject<number>;
  onEditSubmit: GroupHeaderRendererProps["onEditSubmit"];
  onRestoreCheckpoint: GroupHeaderRendererProps["onRestoreCheckpoint"];
}

export function useGroupHeaderRenderer({
  displaySourceGroupIndices,
  sourceGroupCount,
  displayGroupHeaders,
  displayGroupMeta,
  displayGroupCount,
  collapseLabelVariant,
  turnPaginationEnabled,
  tailTurnPhase,
  hideUserMessage,
  defaultTurnCollapsed,
  turnCollapseInteractionAtRef,
  onEditSubmit,
  onRestoreCheckpoint,
}: UseGroupHeaderRendererOptions) {
  return useCallback(
    (groupIndex: number, renderPart: GroupHeaderRenderPart = "all") => {
      const header = displayGroupHeaders[groupIndex];
      const meta = displayGroupMeta[groupIndex];
      const headerKey =
        meta?.turnId ??
        header?.event?.id ??
        header?.chunk_id ??
        `group-${groupIndex}`;

      return (
        <GroupHeaderRenderer
          key={headerKey}
          groupIndex={groupIndex}
          sourceGroupIndex={displaySourceGroupIndices[groupIndex]}
          sourceGroupCount={sourceGroupCount}
          groupHeaders={displayGroupHeaders}
          groupMeta={displayGroupMeta}
          groupCount={displayGroupCount}
          collapseLabelVariant={collapseLabelVariant}
          hideCollapseTimeRange={turnPaginationEnabled}
          tailTurnPhase={tailTurnPhase}
          hideUserMessage={hideUserMessage}
          compactUserMessage={turnPaginationEnabled}
          defaultTurnCollapsed={defaultTurnCollapsed}
          renderPart={renderPart}
          turnCollapseInteractionAtRef={turnCollapseInteractionAtRef}
          onEditSubmit={onEditSubmit}
          onRestoreCheckpoint={onRestoreCheckpoint}
        />
      );
    },
    [
      displaySourceGroupIndices,
      sourceGroupCount,
      displayGroupHeaders,
      displayGroupMeta,
      displayGroupCount,
      collapseLabelVariant,
      turnPaginationEnabled,
      tailTurnPhase,
      hideUserMessage,
      defaultTurnCollapsed,
      turnCollapseInteractionAtRef,
      onEditSubmit,
      onRestoreCheckpoint,
    ]
  );
}
