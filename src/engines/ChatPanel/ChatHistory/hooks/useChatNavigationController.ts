import {
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { useChatHistoryProjectionModel } from "./useChatHistoryProjectionModel";
import type { UseChatHistoryStateReturn } from "./useChatHistoryState";

type ProjectionModel = ReturnType<typeof useChatHistoryProjectionModel>;
type TurnPage = ProjectionModel["pages"][number];

const AGENT_ORG_OVERVIEW_INTERACTION_SELECTOR =
  "[data-agent-org-overview-panel], [data-agent-org-overview-trigger], .agent-org-overview-owned-overlay";

export function isAgentOrgOverviewInteractionTarget(
  target: EventTarget | null
): boolean {
  if (!(target instanceof Node)) return false;
  const element =
    target instanceof Element
      ? target
      : target.parentNode instanceof Element
        ? target.parentNode
        : null;
  return Boolean(element?.closest(AGENT_ORG_OVERVIEW_INTERACTION_SELECTOR));
}

export function resolveConversationHistoryPageIndex({
  activeGroupIndex,
  currentPageIndex,
  pages,
  turnPaginationEnabled,
}: {
  activeGroupIndex: number;
  currentPageIndex: number;
  pages: TurnPage[];
  turnPaginationEnabled: boolean;
}): number {
  if (turnPaginationEnabled) return currentPageIndex;
  const pageIndex = pages.findIndex(
    (page) =>
      activeGroupIndex >= page.startGroupIndex &&
      activeGroupIndex <= page.endGroupIndex
  );
  return pageIndex >= 0 ? pageIndex : Math.max(0, pages.length - 1);
}

interface UseChatNavigationControllerOptions {
  activeId: string | null;
  agentOrgOverviewAvailable: boolean;
  currentPageIndex: number;
  displayGroupCounts: ProjectionModel["displayGroupCounts"];
  displayGroupHeaders: ProjectionModel["displayGroupHeaders"];
  displayGroupMeta: ProjectionModel["displayGroupMeta"];
  displaySourceGroupIndices: ProjectionModel["displaySourceGroupIndices"];
  displayTotalFlatItems: number;
  pages: ProjectionModel["pages"];
  setTurnPageListOpen: ProjectionModel["setTurnPageListOpen"];
  setTurnPageSortAscending: ProjectionModel["setTurnPageSortAscending"];
  turnPageListOpen: boolean;
  turnPaginationEnabled: boolean;
  virtualListRef: UseChatHistoryStateReturn["virtualListRef"];
}

/** Owns user navigation state for overview, minimap and pinned turn chrome. */
export function useChatNavigationController({
  activeId,
  agentOrgOverviewAvailable,
  currentPageIndex,
  displayGroupCounts,
  displayGroupHeaders,
  displayGroupMeta,
  displaySourceGroupIndices,
  displayTotalFlatItems,
  pages,
  setTurnPageListOpen,
  setTurnPageSortAscending,
  turnPageListOpen,
  turnPaginationEnabled,
  virtualListRef,
}: UseChatNavigationControllerOptions) {
  const [agentOrgOverviewOpenSessionId, setAgentOrgOverviewOpenSessionId] =
    useState<string | null>(null);
  const agentOrgOverviewOpen =
    agentOrgOverviewAvailable && agentOrgOverviewOpenSessionId === activeId;
  const setAgentOrgOverviewOpen = useCallback(
    (value: SetStateAction<boolean>) => {
      const nextOpen =
        typeof value === "function" ? value(agentOrgOverviewOpen) : value;
      setAgentOrgOverviewOpenSessionId(nextOpen && activeId ? activeId : null);
    },
    [activeId, agentOrgOverviewOpen]
  );

  useEffect(() => {
    if (!agentOrgOverviewOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (isAgentOrgOverviewInteractionTarget(event.target)) return;
      setAgentOrgOverviewOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [agentOrgOverviewOpen, setAgentOrgOverviewOpen]);

  const [requestedActiveGroupIndex, setActiveGroupIndex] = useState(0);
  const [reportedVisibleGroupIndices, setVisibleGroupIndices] = useState<
    number[]
  >([]);
  const activeGroupIndex = Math.min(
    requestedActiveGroupIndex,
    Math.max(0, displayGroupCounts.length - 1)
  );
  const visibleGroupIndices = useMemo(
    () =>
      reportedVisibleGroupIndices.filter(
        (groupIndex) => groupIndex < displayGroupCounts.length
      ),
    [displayGroupCounts.length, reportedVisibleGroupIndices]
  );
  const handleActiveGroupIndexChange = useCallback(
    (
      groupIndex: number,
      _pinned: boolean,
      nextVisibleGroupIndices: number[]
    ) => {
      setActiveGroupIndex((previousIndex) =>
        previousIndex === groupIndex ? previousIndex : groupIndex
      );
      setVisibleGroupIndices(nextVisibleGroupIndices);
    },
    []
  );
  const handleConversationMinimapNavigate = useCallback(
    (groupIndex: number) => {
      virtualListRef.current?.scrollToGroup({
        groupIndex,
        behavior: "smooth",
      });
    },
    [virtualListRef]
  );
  const conversationHistoryPageIndex = resolveConversationHistoryPageIndex({
    activeGroupIndex,
    currentPageIndex,
    pages,
    turnPaginationEnabled,
  });
  const handleConversationHistoryToggle = useCallback(() => {
    setTurnPageListOpen((open) => !open);
  }, [setTurnPageListOpen]);
  const handleConversationHistoryClose = useCallback(() => {
    setTurnPageListOpen(false);
  }, [setTurnPageListOpen]);
  const handleConversationHistorySortToggle = useCallback(() => {
    setTurnPageSortAscending((ascending) => !ascending);
  }, [setTurnPageSortAscending]);
  const handleConversationHistorySelect = useCallback(
    (pageIndex: number) => {
      const groupIndex = pages[pageIndex]?.startGroupIndex;
      setTurnPageListOpen(false);
      if (groupIndex !== undefined)
        handleConversationMinimapNavigate(groupIndex);
    },
    [handleConversationMinimapNavigate, pages, setTurnPageListOpen]
  );

  const activePinnedDisplayGroupIndex =
    activeGroupIndex < displayGroupHeaders.length ? activeGroupIndex : 0;
  const activePinnedHeader = displayGroupHeaders[activePinnedDisplayGroupIndex];
  const activePinnedMeta = displayGroupMeta[activePinnedDisplayGroupIndex];
  const activePinnedSourceGroupIndex =
    displaySourceGroupIndices[activePinnedDisplayGroupIndex];
  const hasPinnedHeaderContent =
    displayTotalFlatItems > 0 ||
    (turnPaginationEnabled && Boolean(activePinnedHeader));
  const showPinnedTurnHeader =
    hasPinnedHeaderContent &&
    turnPaginationEnabled &&
    !turnPageListOpen &&
    !agentOrgOverviewOpen;

  return {
    activeGroupIndex,
    activePinnedHeader,
    activePinnedMeta,
    activePinnedSourceGroupIndex,
    agentOrgOverviewOpen,
    conversationHistoryPageIndex,
    handleActiveGroupIndexChange,
    handleConversationHistoryClose,
    handleConversationHistorySelect,
    handleConversationHistorySortToggle,
    handleConversationHistoryToggle,
    handleConversationMinimapNavigate,
    setAgentOrgOverviewOpen,
    showPinnedTurnHeader,
    visibleGroupIndices,
  };
}
