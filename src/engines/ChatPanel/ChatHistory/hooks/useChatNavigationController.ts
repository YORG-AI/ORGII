import {
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  captureExternalReplayTurnEpisode,
  externalReplayPlaceholderId,
} from "@src/engines/SessionCore/sync/externalReplayTurnState";
import { loadSessionTurnBodyIntoStore } from "@src/engines/SessionCore/turns";
import { createLogger } from "@src/hooks/logger";

import type { useChatHistoryProjectionModel } from "./useChatHistoryProjectionModel";
import type { UseChatHistoryStateReturn } from "./useChatHistoryState";

type ProjectionModel = ReturnType<typeof useChatHistoryProjectionModel>;
type TurnPage = ProjectionModel["pages"][number];

const logger = createLogger("ChatHistory");

export interface PendingReplayNavigation {
  episodeId: number;
  generation: string | null;
  pageIndex: number;
  sessionId: string;
  turnIndex: number;
}

export type PendingReplayNavigationResolution =
  | { kind: "cancel" }
  | { groupIndex: number; kind: "navigate"; turnId: string | null }
  | { kind: "wait" };

export function resolvePendingReplayNavigation({
  activeId,
  episode,
  page,
  pending,
}: {
  activeId: string | null;
  episode: { generation: string | null; id: number };
  page: TurnPage | undefined;
  pending: PendingReplayNavigation;
}): PendingReplayNavigationResolution {
  if (
    pending.sessionId !== activeId ||
    episode.id !== pending.episodeId ||
    (pending.generation !== null && episode.generation !== pending.generation)
  ) {
    return { kind: "cancel" };
  }
  if (
    !page?.replayBodyLoaded ||
    page.replayTurnSummary?.turnIndex !== pending.turnIndex ||
    page.endGroupIndex < page.startGroupIndex
  ) {
    return { kind: "wait" };
  }
  return {
    kind: "navigate",
    groupIndex: page.startGroupIndex,
    turnId:
      page.replayTurnSummary.renderedUserEventId ??
      page.replayTurnSummary.turnId,
  };
}

export type ConversationHistorySelection =
  | { kind: "load-replay"; turnIndex: number }
  | { groupIndex: number; kind: "navigate"; turnId: string | null }
  | null;

export function resolveConversationHistorySelection(
  page: TurnPage | undefined
): ConversationHistorySelection {
  if (!page) return null;
  if (
    page.replayTurnSummary &&
    (!page.replayBodyLoaded || page.endGroupIndex < page.startGroupIndex)
  ) {
    return {
      kind: "load-replay",
      turnIndex: page.replayTurnSummary.turnIndex,
    };
  }
  if (page.endGroupIndex < page.startGroupIndex) return null;
  return {
    kind: "navigate",
    groupIndex: page.startGroupIndex,
    turnId:
      page.replayTurnSummary?.renderedUserEventId ??
      page.replayTurnSummary?.turnId ??
      null,
  };
}

export function resolveConversationHistoryPageIndex({
  activeGroupIndex,
  currentPageIndex,
  pageIndexByGroupIndex,
  pages,
  turnPaginationEnabled,
}: {
  activeGroupIndex: number;
  currentPageIndex: number;
  pageIndexByGroupIndex: ReadonlyMap<number, number>;
  pages: TurnPage[];
  turnPaginationEnabled: boolean;
}): number {
  if (turnPaginationEnabled) return currentPageIndex;
  return (
    pageIndexByGroupIndex.get(activeGroupIndex) ?? Math.max(0, pages.length - 1)
  );
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
  pageIndexByGroupIndex: ProjectionModel["pageIndexByGroupIndex"];
  pages: ProjectionModel["pages"];
  setTurnPageListOpen: ProjectionModel["setTurnPageListOpen"];
  setTurnPageSortAscending: ProjectionModel["setTurnPageSortAscending"];
  turnPageListOpen: boolean;
  turnPaginationEnabled: boolean;
  manualNavigationAtRef: MutableRefObject<number>;
  virtualListRef: UseChatHistoryStateReturn["virtualListRef"];
}

const HISTORY_NAVIGATION_SETTLE_FRAME_COUNT = 4;

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
  pageIndexByGroupIndex,
  pages,
  setTurnPageListOpen,
  setTurnPageSortAscending,
  turnPageListOpen,
  turnPaginationEnabled,
  manualNavigationAtRef,
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
      const target = event.target;
      if (!(target instanceof Node)) return;
      const element =
        target instanceof Element
          ? target
          : target.parentNode instanceof Element
            ? target.parentNode
            : null;
      if (
        element?.closest(
          "[data-agent-org-overview-panel], [data-agent-org-overview-trigger]"
        )
      ) {
        return;
      }
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
  const pendingReplayNavigationRef = useRef<PendingReplayNavigation | null>(
    null
  );
  const navigationFrameRef = useRef<number | null>(null);
  const scheduleConversationHistoryNavigate = useCallback(
    ({ groupIndex, turnId }: { groupIndex: number; turnId: string | null }) => {
      if (navigationFrameRef.current !== null) {
        cancelAnimationFrame(navigationFrameRef.current);
      }
      manualNavigationAtRef.current = performance.now();

      const navigateAfterLayout = (remainingFrames: number) => {
        navigationFrameRef.current = requestAnimationFrame(() => {
          manualNavigationAtRef.current = performance.now();
          virtualListRef.current?.scrollToGroup({
            groupIndex,
            behavior: "auto",
            turnId,
          });
          if (remainingFrames > 1) {
            navigateAfterLayout(remainingFrames - 1);
          } else {
            navigationFrameRef.current = null;
          }
        });
      };

      // A replay body changes both the group list and measured row heights.
      // Re-resolve the imperative handle for a bounded number of layout
      // frames so an explicit old-round selection wins over tail-follow and
      // converges without requiring the user to nudge the wheel.
      navigateAfterLayout(HISTORY_NAVIGATION_SETTLE_FRAME_COUNT);
    },
    [manualNavigationAtRef, virtualListRef]
  );

  useEffect(() => {
    pendingReplayNavigationRef.current = null;
    if (navigationFrameRef.current !== null) {
      cancelAnimationFrame(navigationFrameRef.current);
      navigationFrameRef.current = null;
    }
  }, [activeId]);

  useEffect(
    () => () => {
      if (navigationFrameRef.current !== null) {
        cancelAnimationFrame(navigationFrameRef.current);
      }
    },
    []
  );

  useEffect(() => {
    const pending = pendingReplayNavigationRef.current;
    if (!pending) return;
    const episode = captureExternalReplayTurnEpisode(pending.sessionId);
    const page = pages[pending.pageIndex];
    const resolution = resolvePendingReplayNavigation({
      activeId,
      episode,
      page,
      pending,
    });
    if (resolution.kind === "cancel") {
      pendingReplayNavigationRef.current = null;
      return;
    }
    if (pending.generation === null && episode.generation !== null) {
      pending.generation = episode.generation;
    }
    if (resolution.kind === "wait") return;
    pendingReplayNavigationRef.current = null;
    scheduleConversationHistoryNavigate(resolution);
  }, [activeId, pages, scheduleConversationHistoryNavigate]);

  const conversationHistoryPageIndex = resolveConversationHistoryPageIndex({
    activeGroupIndex,
    currentPageIndex,
    pageIndexByGroupIndex,
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
      const page = pages[pageIndex];
      const selection = resolveConversationHistorySelection(page);
      setTurnPageListOpen(false);
      pendingReplayNavigationRef.current = null;
      if (navigationFrameRef.current !== null) {
        cancelAnimationFrame(navigationFrameRef.current);
        navigationFrameRef.current = null;
      }
      if (!selection) return;

      if (activeId && selection.kind === "load-replay") {
        const episode = captureExternalReplayTurnEpisode(activeId);
        const pending = {
          episodeId: episode.id,
          generation: episode.generation,
          pageIndex,
          sessionId: activeId,
          turnIndex: selection.turnIndex,
        };
        pendingReplayNavigationRef.current = pending;
        void loadSessionTurnBodyIntoStore({
          sessionId: activeId,
          turnId: externalReplayPlaceholderId(selection.turnIndex),
        }).catch((error: unknown) => {
          const current = pendingReplayNavigationRef.current;
          if (
            current?.sessionId === pending.sessionId &&
            current.pageIndex === pending.pageIndex &&
            current.turnIndex === pending.turnIndex
          ) {
            pendingReplayNavigationRef.current = null;
          }
          logger.warn("Failed to open selected replay round", {
            sessionId: activeId,
            turnIndex: selection.turnIndex,
            error,
          });
        });
        return;
      }

      if (selection.kind === "navigate") {
        scheduleConversationHistoryNavigate(selection);
      }
    },
    [activeId, pages, scheduleConversationHistoryNavigate, setTurnPageListOpen]
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
