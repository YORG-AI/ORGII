import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef } from "react";

import type { CursorIdeTurnSummary } from "@src/api/tauri/externalHistory";
import type { SessionLoadStatus } from "@src/engines/SessionCore";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { addressRunActiveAtom } from "@src/features/Org2Cloud/addressCommentsRun";
import {
  estimateRuntimeValueBytes,
  removeChatRenderedTreeMemoryEntry,
  updateChatRenderedTreeMemoryEntry,
} from "@src/hooks/perf/runtimeMemoryStats";
import {
  collapseAllCommandAtom,
  turnCollapseOverrideAtom,
} from "@src/store/ui/collapseStateAtom";
import { selectedExecutionThreadAtom } from "@src/store/ui/sessionPaginationAtom";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import type { GroupChatContextValue } from "../GroupChatView/GroupChatContext";
import { resolveChatHistoryProjectionSource } from "../projection/source";
import { useChatProjection } from "../projection/useChatProjection";
import type { ChatGroupsProjectionOptions } from "./useChatGroupsProjection";
import { useChatTurnPagination } from "./useChatTurnPagination";
import { useTailTurnCollapse } from "./useTailTurnCollapse";
import {
  useTurnPageNavigation,
  useTurnPageSelectionState,
} from "./useTurnPageSelection";

const DEFAULT_TURN_COLLAPSED = true;

interface UseChatHistoryProjectionModelOptions {
  activeId: string | null;
  chatHistory: SessionEvent[];
  chatHistorySourceIsOverride: boolean;
  chatHistorySourceSessionId: string | null;
  chatHistorySourceVersion: number;
  cursorIdeTurnSummaries: CursorIdeTurnSummary[];
  disableTailCollapse: boolean;
  forceCollapseAllTurns: boolean;
  groupChat: GroupChatContextValue | null;
  hideGroupUserMessage: boolean;
  isAgentWorking: boolean;
  isCursorIde: boolean;
  planningIndicatorCount: 0 | 1;
  sessionLoadStatus: SessionLoadStatus;
  turnPaginationEnabled: boolean;
}

/**
 * Owns the raw-events -> projected groups -> visible turn-page pipeline.
 * Viewport and mutation concerns remain outside this model.
 */
export function useChatHistoryProjectionModel({
  activeId,
  chatHistory,
  chatHistorySourceIsOverride,
  chatHistorySourceSessionId,
  chatHistorySourceVersion,
  cursorIdeTurnSummaries,
  disableTailCollapse,
  forceCollapseAllTurns,
  groupChat,
  hideGroupUserMessage,
  isAgentWorking,
  isCursorIde,
  planningIndicatorCount,
  sessionLoadStatus,
  turnPaginationEnabled,
}: UseChatHistoryProjectionModelOptions) {
  const memoryStatsKeyRef = useRef(Symbol("chat-rendered-tree-memory"));
  const turnCollapseOverrides = useAtomValue(turnCollapseOverrideAtom);
  const collapseAllCommand = useAtomValue(collapseAllCommandAtom);
  const selectedThreadId = useAtomValue(selectedExecutionThreadAtom);
  const collapseTailWhenIdle = useTailTurnCollapse({
    activeId,
    chatHistory,
    disableTailCollapse,
    groupChat,
    isAgentWorking,
    isCursorIde,
  });

  const projectionSource = resolveChatHistoryProjectionSource({
    activeSessionId: activeId,
    sourceIsOverride: chatHistorySourceIsOverride,
    sourceSessionId: chatHistorySourceSessionId,
    sourceVersion: chatHistorySourceVersion,
  });

  const groupOptions = useMemo<ChatGroupsProjectionOptions>(
    () => ({
      collapseOverrides: turnCollapseOverrides,
      isAgentWorking,
      collapseTailWhenIdle,
      forceCollapseAllTurns,
      defaultTurnCollapsed: DEFAULT_TURN_COLLAPSED,
      allTurnsCollapsed:
        collapseAllCommand.epoch > 0 && collapseAllCommand.collapsed
          ? true
          : undefined,
      turnGrouping: groupChat?.enabled
        ? {
            mode: "agent-org",
            coordinatorSessionId: groupChat.coordinatorSessionId,
          }
        : { mode: "standard" },
    }),
    [
      collapseAllCommand,
      collapseTailWhenIdle,
      forceCollapseAllTurns,
      groupChat,
      isAgentWorking,
      turnCollapseOverrides,
    ]
  );
  const projectionOptions = useMemo(
    () => ({
      selectedThreadId,
      skipPolicy: "none" as const,
      groups: groupOptions,
    }),
    [groupOptions, selectedThreadId]
  );
  const projection = useChatProjection({
    sessionId: activeId,
    sourceVersion: projectionSource.sourceVersion,
    events: chatHistory,
    options: projectionOptions,
    enabled: projectionSource.enabled,
  });
  const activeProjectionHistory = projection.optimizedChatHistory;
  const {
    groupCounts,
    groupHeaders,
    groupMeta,
    flatItems,
    totalFlatItems,
    originalToFlatIndex,
    lastAssistantFlatIndexPerItem,
  } = projection.groups ?? {
    groupCounts: [],
    groupHeaders: [],
    groupMeta: [],
    flatItems: [],
    totalFlatItems: 0,
    originalToFlatIndex: new Map<number, number>(),
    lastAssistantFlatIndexPerItem: [],
  };

  useEffect(() => {
    const key = memoryStatsKeyRef.current;
    updateChatRenderedTreeMemoryEntry(key, {
      bytes:
        estimateRuntimeValueBytes(activeProjectionHistory) +
        estimateRuntimeValueBytes(flatItems) +
        groupCounts.length * 8,
      items: totalFlatItems,
      label: activeId ?? "unknown",
    });

    return () => removeChatRenderedTreeMemoryEntry(key);
  }, [
    activeId,
    activeProjectionHistory,
    flatItems,
    groupCounts,
    totalFlatItems,
  ]);

  const {
    selectedTurnPageIndex,
    setTurnPageSelection,
    turnPageListOpen,
    setTurnPageListOpen,
    turnPageSortAscending,
    setTurnPageSortAscending,
  } = useTurnPageSelectionState(activeId);
  const turnPages = useChatTurnPagination({
    enabled: turnPaginationEnabled,
    activePageIndex: selectedTurnPageIndex,
    groupCounts,
    groupHeaders,
    groupMeta,
    flatItems,
    lastAssistantFlatIndexPerItem,
    cursorIdeTurnSummaries,
    mergeUserOnlyPages: hideGroupUserMessage,
  });
  const { pageCount, currentPageIndex, pages } = turnPages;

  const addressRunActiveMap = useAtomValue(addressRunActiveAtom);
  const addressRunActive = Boolean(activeId && addressRunActiveMap[activeId]);
  const prevAddressRunActiveRef = useRef(false);
  useEffect(() => {
    const rose = addressRunActive && !prevAddressRunActiveRef.current;
    prevAddressRunActiveRef.current = addressRunActive;
    if (!rose || !turnPaginationEnabled || !activeId || pageCount <= 0) return;
    setTurnPageSelection((current) =>
      current.sessionId === activeId && current.pageIndex !== null
        ? current
        : { pageIndex: currentPageIndex, sessionId: activeId }
    );
  }, [
    addressRunActive,
    turnPaginationEnabled,
    activeId,
    pageCount,
    currentPageIndex,
    setTurnPageSelection,
  ]);

  const turnPageNavigation = useTurnPageNavigation({
    activeId,
    pageCount,
    currentPageIndex,
    pages,
    groupMeta,
    sessionLoadStatus,
    turnPaginationEnabled,
    setTurnPageSelection,
    setTurnPageListOpen,
  });
  const planningIndicatorEnabled =
    !turnPaginationEnabled || currentPageIndex >= pageCount - 1;
  const collapseStateKey = useMemo(() => {
    const overrideKey = Array.from(turnCollapseOverrides.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([turnId, collapsed]) => `${turnId}:${collapsed ? 1 : 0}`)
      .join("|");
    return `${collapseAllCommand.epoch}:${collapseAllCommand.collapsed ? 1 : 0}:${overrideKey}`;
  }, [collapseAllCommand, turnCollapseOverrides]);
  const pageKey = turnPaginationEnabled ? `page-${currentPageIndex}` : "all";
  const virtualListDataKey = [
    activeId ?? "no-session",
    pageKey,
    projection.groupShapeDigest,
    projection.itemShapeDigest,
    collapseStateKey,
  ].join(":");
  const displayTurnIds = useMemo(
    () => turnPages.displayGroupMeta.map((meta) => meta.turnId),
    [turnPages.displayGroupMeta]
  );
  const turnMetadataReloadKey = [
    activeId ?? "",
    isAgentWorking ? "working" : "idle",
    activeId && isImportedHistorySession(activeId)
      ? chatHistorySourceVersion
      : "native",
  ].join(":");
  const tailFollowKey = useMemo(() => {
    const tailItem =
      turnPages.displayFlatItems[turnPages.displayFlatItems.length - 1];
    const tailEvent = tailItem?.event;
    return [
      activeId ?? "no-session",
      tailItem?.chunk_id ?? "no-tail",
      tailEvent?.displayStatus ?? "",
      tailEvent?.activityStatus ?? "",
      tailEvent?.displayText?.length ?? 0,
      turnPages.displayTotalFlatItems,
      planningIndicatorCount,
    ].join(":");
  }, [activeId, planningIndicatorCount, turnPages]);

  return {
    activeProjectionHistory,
    collapseTailWhenIdle,
    defaultTurnCollapsed: DEFAULT_TURN_COLLAPSED,
    displayTurnIds,
    flatItems,
    groupCounts,
    groupHeaders,
    groupMeta,
    originalToFlatIndex,
    planningIndicatorEnabled,
    projection,
    tailFollowKey,
    totalFlatItems,
    turnMetadataReloadKey,
    turnPageListOpen,
    setTurnPageListOpen,
    turnPageSortAscending,
    setTurnPageSortAscending,
    virtualListDataKey,
    ...turnPages,
    ...turnPageNavigation,
  };
}
