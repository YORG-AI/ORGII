/**
 * ChatHistory Component
 *
 * Slim orchestrator that wires extracted hooks and presentational
 * components together. All business logic lives in hooks/.
 *
 * Uses TanStack Virtual so each user-message turn is virtualized as a
 * measured group with response items below. Groups are separated by
 * a visual gap.
 */
import { useAtomValue } from "jotai";
import { Loader2 } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { usePlanningIndicator } from "@src/engines/SessionCore/hooks";
import {
  estimateRuntimeValueBytes,
  removeChatRenderedTreeMemoryEntry,
  updateChatRenderedTreeMemoryEntry,
} from "@src/hooks/perf/runtimeMemoryStats";
import { isSessionActiveAtom } from "@src/store/session/cliSessionStatusAtom";
import { cursorIdeTurnSummariesAtomFamily } from "@src/store/session/cursorIdeTurnSummariesAtom";
import type { ChatHistoryDisplayMode } from "@src/store/ui/chatPanelAtom";
import {
  collapseAllCommandAtom,
  turnCollapseOverrideAtom,
} from "@src/store/ui/collapseStateAtom";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";

import SessionHeader from "../ChatItems/SessionHeader";
import { useChatSessionId } from "../ChatSessionContext";
import ChatPinnedBars, {
  usePinnedContent,
} from "../InputArea/components/ChatPinnedBars";
import { useGroupChatContext } from "./GroupChatView/GroupChatContext";
import {
  isAgentOrgGroupChatUserMessage,
  isAgentOrgInboxTranscriptEvent,
  isCoordinatorHumanUserEvent,
} from "./GroupChatView/groupChatUtils";
import { ChatHistoryDisplayModeProvider } from "./chatDisplayModeContext";
import type { OptimizedChatItem } from "./chatItemPipeline/types";
import ChatHistoryEmptyState from "./components/ChatHistoryEmptyState";
import ChatHistoryList from "./components/ChatHistoryList";
import ChatPinnedHeaderLayer from "./components/ChatPinnedHeaderLayer";
import ChatSearchBar from "./components/ChatSearchBar";
import RevertConfirmDialog from "./components/RevertConfirmDialog";
import TurnPageList from "./components/TurnPageList";
import {
  useChatEmptyState,
  useChatFooterSpacer,
  useChatGroups,
  useChatHistoryOptimization,
  useChatHistoryState,
  useChatPagination,
  useChatScroll,
  useChatScrollPin,
  useChatSearchIntegration,
  useChatTurnPagination,
  useEditUserMessage,
  useGroupHeaderRenderer,
  useReloadSession,
  useRestoreCheckpoint,
  useTurnPageNavigation,
  useTurnPageSelectionState,
} from "./hooks";
import "./index.scss";

// ============================================
// PlanningIndicatorBridge
// ============================================

/**
 * Thin wrapper that owns the `usePlanningIndicator` subscription so that the
 * hot `eventStoreVersionAtom` ticker does not cause `ChatHistory` (the
 * orchestrator) to re-render on every streaming token.
 *
 * All props that would otherwise be threaded through the orchestrator are
 * forwarded directly to `ChatHistoryList`. The planning values produced here
 * are purely for display; the orchestrator gets only the binary 0/1 count
 * back (via `onPlanningIndicatorCount`) so `useChatFooterSpacer` can
 * re-measure when the footer appears / disappears.
 */
interface PlanningIndicatorBridgeProps extends Omit<
  React.ComponentProps<typeof ChatHistoryList>,
  "planningIndicatorCount" | "planningShowSlowHint" | "planningVariantIndex"
> {
  planningIndicatorScope: { sessionId: string; isLive: boolean } | null;
  planningIndicatorEnabled: boolean;
  /**
   * Called whenever the visible count (0 or 1) changes. Stable identity —
   * created once with `useCallback([], [])` in the orchestrator.
   */
  onPlanningIndicatorCount: (count: 0 | 1) => void;
}

const PlanningIndicatorBridge: React.FC<PlanningIndicatorBridgeProps> = ({
  planningIndicatorScope,
  planningIndicatorEnabled,
  onPlanningIndicatorCount,
  ...chatHistoryListProps
}) => {
  const { count, showSlowHint, variantIndex } = usePlanningIndicator(
    planningIndicatorScope
  );
  const visibleCount = planningIndicatorEnabled ? count : 0;

  // Notify the orchestrator whenever the count flips so useChatFooterSpacer
  // can schedule a re-measurement.
  useEffect(() => {
    onPlanningIndicatorCount(visibleCount);
  }, [visibleCount, onPlanningIndicatorCount]);

  return (
    <ChatHistoryList
      {...chatHistoryListProps}
      planningIndicatorCount={visibleCount}
      planningShowSlowHint={planningIndicatorEnabled && showSlowHint}
      planningVariantIndex={variantIndex}
    />
  );
};

PlanningIndicatorBridge.displayName = "PlanningIndicatorBridge";

// ============================================
// Component
// ============================================

const renderNoGroupHeader = () => <div aria-hidden style={{ minHeight: 1 }} />;
const TAIL_TURN_COLLAPSE_IDLE_MS = 60_000;
const EMPTY_ORG_MEMBERS: AgentOrgRunMemberView[] = [];
const BOTTOM_OVERLAY_FADE_PX = 32;
const SCROLL_NAV_SHOW_THRESHOLD_PX = 48;

export interface FollowAgentNavState {
  showFollowAgent: boolean;
  followAgentLabel: string;
  followAgentTooltipLabel: string;
  followAgentShortcut: string;
  onFollowAgent: () => void;
}

export interface BrowserAddToConversationNavState {
  showAddToConversation: boolean;
  addToConversationLabel: string;
  addToConversationTooltipLabel: string;
  onAddToConversation: () => void;
}

export interface ScrollNavState
  extends FollowAgentNavState, BrowserAddToConversationNavState {
  showScrollToBottom: boolean;
  onScrollToBottom: () => void;
}

const EMPTY_FOLLOW_AGENT_NAV: FollowAgentNavState = {
  showFollowAgent: false,
  followAgentLabel: "",
  followAgentTooltipLabel: "",
  followAgentShortcut: "",
  onFollowAgent: () => undefined,
};

const EMPTY_BROWSER_ADD_TO_CONVERSATION_NAV: BrowserAddToConversationNavState =
  {
    showAddToConversation: false,
    addToConversationLabel: "",
    addToConversationTooltipLabel: "",
    onAddToConversation: () => undefined,
  };

interface ChatHistoryProps {
  /** Opaque background class for sticky headers. Must match the container surface. */
  surfaceBgClass?: string;
  agentOrgCurrentMemberName?: string | null;
  /**
   * Stable identifier of the member currently being viewed in the chat
   * pipeline. Used by the member-switcher dropdown to highlight + check
   * the active row, since two members can share a `name`.
   */
  agentOrgCurrentMemberId?: string | null;
  agentOrgMembers?: AgentOrgRunMemberView[];
  agentOrgOverviewPanel?: React.ReactNode;
  onAgentOrgMemberSelect?: (member: AgentOrgRunMemberView) => void;
  onAgentOrgRunViewRefresh?: () => Promise<void>;
  /** Called whenever scroll-nav visibility state changes. Used by ChatView to render buttons in the pill row. */
  onScrollNavChange?: (state: ScrollNavState) => void;
  followAgentNav?: FollowAgentNavState;
  browserAddToConversationNav?: BrowserAddToConversationNavState;
  onRegisterSearchOpen?: (handler: (() => void) | null) => void;
  displayMode?: ChatHistoryDisplayMode;
  turnPaginationEnabled?: boolean;
  /** Optional external host for pinned/pagination chrome, outside the scroll body subtree. */
  pinnedHeaderPortalHost?: HTMLElement | null;
  /** Height in px of the overlapping input area so the footer spacer keeps the last message reachable. */
  bottomInset?: number;
  /**
   * Suppress the in-history pinned bars (plan-todo / kanban summary that
   * float above the last group). Used by subagent panes which surface the
   * same content via a hover-revealed popover above the cell title instead
   * — keeping the cell viewport reserved entirely for chat events.
   */
  hidePinnedBars?: boolean;
  /**
   * Default every multi-item turn to collapsed (header + tail summary only)
   * regardless of streaming / tail / item-count gating. Subagent panes use
   * this so a 4-cell strip stays scannable; the user can still expand a
   * turn by clicking its in-history collapse pin-bar.
   */
  forceCollapseAllTurns?: boolean;
  /**
   * Suppress the "tail collapses after idle" rule so the latest turn (and
   * — in turn-pagination mode where each page is exactly one turn — every
   * surfaced turn) always renders expanded. Used by subagent panes where
   * the dense single-turn view *is* the affordance: an "Agent worked for
   * X" pin bar over a hidden last event would defeat the point of the
   * cell. Historical turns in a non-paginated view still collapse via the
   * normal historical-turn rules.
   */
  disableTailCollapse?: boolean;
  /**
   * Optional trailing slot passed through to {@link TurnPaginationControls}.
   * Rendered after the prev / next / last round buttons. Subagent panes
   * inject a "toggle task-pin card" button here so it sits with the
   * round controls rather than the replay footer. Has no effect when
   * `turnPaginationEnabled` is false (the row is hidden entirely).
   */
  paginationTrailingSlot?: React.ReactNode;
  /**
   * Skip rendering each turn's leading user-message card
   * ("Task assigned by Coordinator: …" in subagent sessions). The
   * `TurnCollapsePinBar` ("Agent worked for X") still renders so the
   * cell keeps a turn boundary affordance. Used by subagent panes,
   * which surface the prompt via a toggle in the pagination row.
   */
  hideGroupUserMessage?: boolean;
  /**
   * When set, a `NewEventDivider` with this label is painted above
   * each turn's last visible item. Subagent panes set it to the
   * localized "New event" string so the freshest event in every
   * round is signposted.
   */
  newEventDividerLabel?: string | null;
  /**
   * Passed through to {@link TurnPaginationControls}. When `true`, the
   * agent dropdown surfaces a "Group chat" entry above the member list.
   */
  groupChatViewAvailable?: boolean;
  /** Whether the group chat view is currently active. */
  groupChatViewActive?: boolean;
  /** Toggle handler for the group chat view entry. */
  onGroupChatViewToggle?: (active: boolean) => void;
  mutationActionsDisabled?: boolean;
  /**
   * Drive the "Planning next step…" footer from a specific session's
   * snapshot channel instead of the global active-session atoms. REQUIRED

   * for session-scoped instances (subagent monitor cells): without it the
   * footer reads the parent session's state and is structurally dead or
   * wrong. `isLive` should be false while the surface shows a replay
   * slice (scrubbed cursor) so the footer never animates over history.
   */
  planningIndicatorScope?: { sessionId: string; isLive: boolean } | null;
}

const ChatHistory: React.FC<ChatHistoryProps> = ({
  surfaceBgClass = "bg-chat-pane",
  agentOrgCurrentMemberName = null,
  agentOrgCurrentMemberId = null,
  agentOrgMembers = EMPTY_ORG_MEMBERS,
  agentOrgOverviewPanel,
  onAgentOrgMemberSelect,
  onAgentOrgRunViewRefresh,
  onScrollNavChange,
  followAgentNav = EMPTY_FOLLOW_AGENT_NAV,
  browserAddToConversationNav = EMPTY_BROWSER_ADD_TO_CONVERSATION_NAV,
  onRegisterSearchOpen,
  displayMode = "full",
  turnPaginationEnabled = true,
  pinnedHeaderPortalHost = null,
  bottomInset = 0,
  hidePinnedBars = false,
  forceCollapseAllTurns = false,
  disableTailCollapse = false,
  paginationTrailingSlot,
  hideGroupUserMessage = false,
  newEventDividerLabel = null,
  groupChatViewAvailable = false,
  groupChatViewActive = false,
  onGroupChatViewToggle,
  mutationActionsDisabled = false,
  planningIndicatorScope = null,
}) => {
  const { t } = useTranslation();

  // Reload + active-id bookkeeping target the session bound to this
  // ChatView (via ChatSessionContext), not the global active session,
  // so kanban detail panels don't race with WorkStation's session.
  const contextSessionId = useChatSessionId();
  const activeId = contextSessionId ?? null;

  const rawCursorIdeTurnSummaries = useAtomValue(
    cursorIdeTurnSummariesAtomFamily(activeId ?? "")
  );
  const isCursorIde = activeId ? isCursorIdeSession(activeId) : false;
  const cursorIdeTurnSummaries = isCursorIde ? rawCursorIdeTurnSummaries : [];
  const handleReloadSession = useReloadSession(activeId);
  // --- State ---
  const {
    chatHistory,
    chatContainerRef,
    atBottom,
    setAtBottom,
    setVisibleRange,
    virtualListRef,
    chatFontSize,
    chatCodeFontSize,
    chatLineHeight,
    codeBlockContainerWidth,
    sessionLoadStatus,
    sessionLoadError,
    setIsChatScrolledToBottom,
    isWpGeneWorkingRef,
    isExploringRef,
    handleReplyQuestionRef,
    handleIgnoreQuestionRef,
  } = useChatHistoryState();

  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const memoryStatsKeyRef = useRef(Symbol("chat-rendered-tree-memory"));
  const staticScrollerRef = useRef<HTMLDivElement>(null);

  const {
    showFollowAgent,
    followAgentLabel,
    followAgentTooltipLabel,
    followAgentShortcut,
    onFollowAgent,
  } = followAgentNav;
  const {
    showAddToConversation,
    addToConversationLabel,
    addToConversationTooltipLabel,
    onAddToConversation,
  } = browserAddToConversationNav;

  const { hasPinnedContent: hasPinnedContentRaw } = usePinnedContent();
  // Subagent panes opt out of in-history pinned bars; they surface the same
  // content via a hover popover on the cell title row instead.
  const hasPinnedContent = hidePinnedBars ? false : hasPinnedContentRaw;
  const isAgentWorking = useAtomValue(isSessionActiveAtom);
  const [tailIdleReadyKey, setTailIdleReadyKey] = useState<string | null>(null);
  const turnCollapseOverrides = useAtomValue(turnCollapseOverrideAtom);
  const collapseAllCommand = useAtomValue(collapseAllCommandAtom);

  // --- Optimization ---
  const { optimizedChatHistory, sessionInfo } =
    useChatHistoryOptimization(chatHistory);

  const groupChat = useGroupChatContext();
  const isTurnHeaderItem = useMemo(() => {
    if (groupChat?.enabled) {
      return (item: OptimizedChatItem) => {
        const event = item.event;
        if (!event) return false;
        return isCoordinatorHumanUserEvent(
          event,
          groupChat.coordinatorSessionId
        );
      };
    }
    return (item: OptimizedChatItem) => {
      const event = item.event;
      if (event?.source !== "user") return false;
      if (!event.displayText) return false;
      return !isAgentOrgInboxTranscriptEvent(event);
    };
  }, [groupChat]);

  const isTurnBoundaryItem = useMemo(() => {
    if (!groupChat?.enabled) return undefined;
    return (item: OptimizedChatItem) => {
      const event = item.event;
      return Boolean(event && isAgentOrgGroupChatUserMessage(event));
    };
  }, [groupChat?.enabled]);

  const tailTurnId = useMemo(() => {
    for (let index = optimizedChatHistory.length - 1; index >= 0; index--) {
      const event = optimizedChatHistory[index].event;
      if (!event?.id) continue;
      if (groupChat?.enabled) {
        if (groupChat.isCoordinatorTurnHeader(event)) return event.id;
        continue;
      }
      if (event.source === "user" && !isAgentOrgInboxTranscriptEvent(event)) {
        return event.id;
      }
    }
    return null;
  }, [optimizedChatHistory, groupChat]);

  const tailIdleKey =
    !isAgentWorking && !isCursorIde && activeId && tailTurnId
      ? `${activeId}:${tailTurnId}`
      : null;
  const collapseTailWhenIdle =
    !disableTailCollapse &&
    tailIdleKey !== null &&
    tailIdleReadyKey === tailIdleKey;

  useEffect(() => {
    if (!tailIdleKey) return;

    const timeoutId = window.setTimeout(() => {
      setTailIdleReadyKey(tailIdleKey);
    }, TAIL_TURN_COLLAPSE_IDLE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [tailIdleKey]);

  // planningIndicatorCount is hoisted up via a stable callback so
  // useChatFooterSpacer can re-measure when the planning footer appears /
  // disappears. The count itself is 0 or 1, so this setter is called at most
  // twice per session; it does NOT subscribe to eventStoreVersionAtom here.
  // showSlowHint and variantIndex stay inside PlanningIndicatorBridge.
  const [planningIndicatorCount, setPlanningIndicatorCount] = useState<0 | 1>(
    0
  );
  const handlePlanningIndicatorCount = useCallback((count: 0 | 1) => {
    setPlanningIndicatorCount((previous) =>
      previous === count ? previous : count
    );
  }, []);

  const defaultTurnCollapsed = forceCollapseAllTurns;

  // --- Grouping for virtualized chat rows ---
  //
  // `useChatGroups` applies the shared "Agent worked for …" collapse
  // STRUCTURALLY: collapsed turns drop all but their final assistant
  // message before flatItems/groupCounts are returned. Hiding items inline
  // leaves virtualization measurement caches stuck at pre-collapse heights,
  // which shows up as a tall blank tail beneath the surviving last reply.
  const {
    groupCounts,
    groupHeaders,
    groupMeta,
    flatItems,
    totalFlatItems,
    originalToFlatIndex,
    lastGroupFirstFlatIndex: _lastGroupFirstFlatIndex,
    lastAssistantFlatIndexPerItem,
  } = useChatGroups(optimizedChatHistory, {
    collapseOverrides: turnCollapseOverrides,
    isAgentWorking,
    collapseTailWhenIdle,
    forceCollapseAllTurns,
    defaultTurnCollapsed,
    allTurnsCollapsed:
      collapseAllCommand.epoch > 0 && collapseAllCommand.collapsed
        ? true
        : undefined,
    isTurnBoundaryItem,
    isTurnHeaderItem,
  });

  useEffect(() => {
    const key = memoryStatsKeyRef.current;
    updateChatRenderedTreeMemoryEntry(key, {
      bytes:
        estimateRuntimeValueBytes(optimizedChatHistory) +
        estimateRuntimeValueBytes(flatItems) +
        groupCounts.length * 8,
      items: totalFlatItems,
      label: activeId ?? "unknown",
    });

    return () => removeChatRenderedTreeMemoryEntry(key);
  }, [activeId, flatItems, groupCounts, optimizedChatHistory, totalFlatItems]);

  // --- Turn page selection state ---
  // Owns the user-selected page index that drives `useChatTurnPagination`.
  // Must run before the pagination hook so its resolved index can be
  // threaded into `activePageIndex`.
  const {
    selectedTurnPageIndex,
    setTurnPageSelection,
    turnPageListOpen,
    setTurnPageListOpen,
    turnPageSortAscending,
    setTurnPageSortAscending,
  } = useTurnPageSelectionState(activeId);
  const [agentOrgOverviewOpenSessionId, setAgentOrgOverviewOpenSessionId] =
    useState<string | null>(null);
  const agentOrgOverviewOpen =
    Boolean(agentOrgOverviewPanel) &&
    agentOrgOverviewOpenSessionId === activeId;
  const setAgentOrgOverviewOpen = useCallback(
    (value: React.SetStateAction<boolean>) => {
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

  const {
    pageCount,
    currentPageIndex,
    pages,
    displayGroupCounts,
    displayGroupHeaders,
    displayGroupMeta,
    displayFlatItems,
    displayTotalFlatItems,
    displayLastAssistantFlatIndexPerItem,
    displaySourceGroupIndices,
    displayLastGroupFirstFlatIndex,
  } = useChatTurnPagination({
    enabled: turnPaginationEnabled,
    activePageIndex: selectedTurnPageIndex,
    groupCounts,
    groupHeaders,
    groupMeta,
    flatItems,
    lastAssistantFlatIndexPerItem,
    cursorIdeTurnSummaries,
    // Surfaces that hide user-message cards (subagent cells) must not
    // paginate user-only turns into standalone pages — those pages would
    // render structurally blank (e.g. queued messages flushed into a
    // dead subagent session).
    mergeUserOnlyPages: hideGroupUserMessage,
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
  const virtualListGroupShapeKey = displayGroupCounts.join(",");
  const virtualListItemShapeKey = displayFlatItems
    .map((item) => item.chunk_id)
    .join(",");
  const virtualListDataKey = `${activeId ?? "no-session"}:${
    turnPaginationEnabled ? `page-${currentPageIndex}` : "all"
  }:${virtualListGroupShapeKey}:${virtualListItemShapeKey}:${collapseStateKey}`;

  // --- Empty-state grace period ---
  const optimizedLen = chatHistory.length;
  const { shouldShowEmpty, emptyConfirmed, isRolledBack, isPendingCancelRef } =
    useChatEmptyState({ sessionLoadStatus, optimizedLen });

  // `lastAssistantFlatIndexPerItem` now comes out of `useChatGroups` so the
  // collapse pass and the "final reply" marker share the same predicate
  // (`isCompletedAssistantMessage`). See useChatGroups for the details.

  // --- Search ---
  const {
    search,
    isSearchVisible,
    searchBarRef,
    handleOpenSearch,
    handleCloseSearch,
  } = useChatSearchIntegration({
    chatHistory,
    optimizedChatHistory,
    virtualListRef,
    chatContainerRef,
    originalToFlatIndex,
  });

  useEffect(() => {
    onRegisterSearchOpen?.(handleOpenSearch);
    return () => {
      onRegisterSearchOpen?.(null);
    };
  }, [onRegisterSearchOpen, handleOpenSearch]);

  const visibleRangeEndRef = useRef(0);
  const [activePinnedGroupIndex, setActivePinnedGroupIndex] = useState(0);
  const [activeGroupPinned, setActiveGroupPinned] = useState(false);
  const handleActiveGroupIndexChange = useCallback(
    (groupIndex: number, pinned: boolean) => {
      setActivePinnedGroupIndex((previousIndex) =>
        previousIndex === groupIndex ? previousIndex : groupIndex
      );
      setActiveGroupPinned((previousPinned) =>
        previousPinned === pinned ? previousPinned : pinned
      );
    },
    []
  );
  useEffect(() => {
    setActivePinnedGroupIndex((previousIndex) =>
      Math.min(previousIndex, Math.max(0, displayGroupCounts.length - 1))
    );
    setActiveGroupPinned(false);
  }, [activeId, currentPageIndex, displayGroupCounts.length]);

  // Shared scroll intent refs — owned here, passed into scroll hooks so
  // they coordinate without re-renders.
  const pinLastGroupRef = useRef(false);
  const manualScrollAtRef = useRef(0);
  const turnCollapseInteractionAtRef = useRef(0);
  const [reservePinToTop, setReservePinToTop] = React.useState(false);
  const handlePinToTopChange = useCallback((active: boolean) => {
    setReservePinToTop(active);
  }, []);

  // --- Pagination ---
  const { isLoadingMore, handleRangeChanged, handleEndReached } =
    useChatPagination({
      optimizedChatHistoryLength: totalFlatItems,
      setVisibleRange,
      visibleRangeEndRef,
    });

  // --- Footer spacer ---
  const { footerSpacerHeight, virtuosoScrollerRef, isContentOverflowingRef } =
    useChatFooterSpacer({
      scrollAreaRef,
      optimizedChatHistoryLength: optimizedChatHistory.length,
      totalFlatItems: displayTotalFlatItems,
      planningIndicatorCount,
      lastGroupFirstFlatIndex: displayLastGroupFirstFlatIndex,
      bottomInset,
      reservePinToTop,
      manualScrollAtRef,
    });
  const [isBottomSentinelVisible, setIsBottomSentinelVisible] = useState(true);

  useEffect(() => {
    if (displayTotalFlatItems <= 0) {
      setIsBottomSentinelVisible(true);
      return;
    }
    const root = staticScrollerRef.current ?? virtuosoScrollerRef.current;
    if (!root) {
      setIsBottomSentinelVisible(false);
      return;
    }

    let rafId = 0;
    let lastMeasurementKey = "";
    const updateBottomLineVisibility = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const measurementKey = [
          root.scrollTop,
          root.scrollHeight,
          root.clientHeight,
          footerSpacerHeight,
        ].join(":");
        if (measurementKey === lastMeasurementKey) return;
        lastMeasurementKey = measurementKey;

        const distanceToPhysicalBottom =
          root.scrollHeight - root.scrollTop - root.clientHeight;
        const nextVisible =
          distanceToPhysicalBottom <= SCROLL_NAV_SHOW_THRESHOLD_PX;
        setIsBottomSentinelVisible((previousVisible) =>
          previousVisible === nextVisible ? previousVisible : nextVisible
        );
      });
    };

    updateBottomLineVisibility();
    root.addEventListener("scroll", updateBottomLineVisibility, {
      passive: true,
    });

    const resizeObserver = new ResizeObserver(updateBottomLineVisibility);
    resizeObserver.observe(root);
    if (root.firstElementChild) {
      resizeObserver.observe(root.firstElementChild);
    }

    return () => {
      cancelAnimationFrame(rafId);
      root.removeEventListener("scroll", updateBottomLineVisibility);
      resizeObserver.disconnect();
    };
  }, [
    activeId,
    displayTotalFlatItems,
    footerSpacerHeight,
    staticScrollerRef,
    virtuosoScrollerRef,
  ]);

  // --- Scroll ---
  const { handleAtBottomStateChange, scrollToBottom } = useChatScroll({
    optimizedChatHistoryLength: displayTotalFlatItems,
    virtuosoScrollerRef,
    atBottom,
    setAtBottom,
    setIsChatScrolledToBottom,
    isPendingCancelRef,
    visibleRangeEndRef,
    pinLastGroupRef,
    manualScrollAtRef,
    turnCollapseInteractionAtRef,
    isContentOverflowingRef,
    activeSessionId: activeId,
    staticScrollerRef,
    alwaysFollowTail: disableTailCollapse,
  });
  // Subagent panes pass `disableTailCollapse` because every paginated page
  // is exactly one turn and the user expects the cell to show the freshest
  // event in that turn at all times. After mount the pane still needs to
  // fall back to the tail whenever:
  //   (a) the user switches round (currentPageIndex changes), or
  //   (b) the underlying event stream grows (live streaming, or replay
  //       cursor advancing through `slicedEvents`).
  // So when the caller opts in we defensively scroll to the shared
  // content-bottom target on a rAF tick keyed by the same invalidation triple.
  useEffect(() => {
    if (!disableTailCollapse) return;
    if (displayTotalFlatItems <= 0) return;
    const handle = window.requestAnimationFrame(() => scrollToBottom());
    return () => window.cancelAnimationFrame(handle);
  }, [
    disableTailCollapse,
    activeId,
    currentPageIndex,
    displayTotalFlatItems,
    scrollToBottom,
  ]);

  // --- Scroll pin ---
  useChatScrollPin({
    activeId,
    groupCounts: displayGroupCounts,
    totalFlatItems: displayTotalFlatItems,
    sessionLoadStatus,
    virtuosoScrollerRef,
    atBottom,
    isPendingCancelRef,
    isContentOverflowingRef,
    optimizedChatHistoryLength: optimizedChatHistory.length,
    pinLastGroupRef,
    manualScrollAtRef,
    onPinToTopChange: handlePinToTopChange,
    staticScrollerRef,
  });

  const showScrollToBottom =
    displayTotalFlatItems > 0 && !isBottomSentinelVisible;

  // Notify parent of scroll-nav state changes
  React.useEffect(() => {
    onScrollNavChange?.({
      showScrollToBottom,
      onScrollToBottom: scrollToBottom,
      showFollowAgent,
      followAgentLabel,
      followAgentTooltipLabel,
      followAgentShortcut,
      onFollowAgent,
      showAddToConversation,
      addToConversationLabel,
      addToConversationTooltipLabel,
      onAddToConversation,
    });
  }, [
    showScrollToBottom,
    scrollToBottom,
    showFollowAgent,
    followAgentLabel,
    followAgentTooltipLabel,
    followAgentShortcut,
    onFollowAgent,
    showAddToConversation,
    addToConversationLabel,
    addToConversationTooltipLabel,
    onAddToConversation,
    onScrollNavChange,
  ]);

  // --- Ref accessor callbacks (avoids reading .current during JSX render) ---
  const getIsWpGeneWorking = useCallback(
    () => isWpGeneWorkingRef.current ?? false,
    [isWpGeneWorkingRef]
  );
  const getIsExploring = useCallback(
    () => isExploringRef.current ?? false,
    [isExploringRef]
  );

  // --- Stable handlers ---
  const handleEditUserMessage = useEditUserMessage();
  const handleRestoreCheckpoint = useRestoreCheckpoint();
  const pinnedEditSubmitRef = useRef(handleEditUserMessage);
  useEffect(() => {
    pinnedEditSubmitRef.current = handleEditUserMessage;
  }, [handleEditUserMessage]);
  const handlePinnedEditSubmit = useCallback(
    (header: OptimizedChatItem, newText: string, imageDataUrls?: string[]) => {
      return pinnedEditSubmitRef.current(header, newText, imageDataUrls);
    },
    []
  );
  const pinnedRestoreRef = useRef(handleRestoreCheckpoint);
  useEffect(() => {
    pinnedRestoreRef.current = handleRestoreCheckpoint;
  }, [handleRestoreCheckpoint]);
  const handleHeaderRestoreCheckpoint = useCallback(
    (header: OptimizedChatItem) => {
      return pinnedRestoreRef.current(header);
    },
    []
  );
  const regenerateStateRef = useRef({
    displaySourceGroupIndices,
    groupHeaders,
    handleEditUserMessage,
  });
  useEffect(() => {
    regenerateStateRef.current = {
      displaySourceGroupIndices,
      groupHeaders,
      handleEditUserMessage,
    };
  }, [displaySourceGroupIndices, groupHeaders, handleEditUserMessage]);

  const handleRegenerateGroup = useCallback((groupIndex: number) => {
    const {
      displaySourceGroupIndices: currentSourceGroupIndices,
      groupHeaders: currentGroupHeaders,
      handleEditUserMessage: currentHandleEditUserMessage,
    } = regenerateStateRef.current;
    const sourceGroupIndex =
      currentSourceGroupIndices[groupIndex] ?? groupIndex;
    const header = currentGroupHeaders[sourceGroupIndex];
    if (!header?.event) return;
    const originalText =
      typeof header.event.displayText === "string"
        ? header.event.displayText
        : "";
    if (!originalText.trim()) return;
    const images = (header.event.result as Record<string, unknown>)?.images as
      | string[]
      | undefined;
    void currentHandleEditUserMessage(header, originalText, images);
  }, []);
  const memoizedSubmit = useCallback(
    (eventId: string, answers: Record<string, string>) => {
      const reply = Object.values(answers).join("\n");
      handleReplyQuestionRef.current({ reply, chunk_id: eventId });
    },
    [handleReplyQuestionRef]
  );

  const stableHandleIgnoreQuestion = useCallback(
    (eventId: string) => handleIgnoreQuestionRef.current(eventId),
    [handleIgnoreQuestionRef]
  );

  // --- Turn page navigation + lazy-load + labels ---
  const {
    selectTurnPage,
    handlePreviousTurnPage,
    handleNextTurnPage,
    handleLastTurnPage,
    turnPaginationReady,
    currentTurnPageLabel,
    currentTurnPageTimeLabel,
  } = useTurnPageNavigation({
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

  const handleTurnPageEndReached = useCallback(() => {
    if (!turnPaginationEnabled) handleEndReached();
  }, [turnPaginationEnabled, handleEndReached]);

  const renderGroupHeader = useGroupHeaderRenderer({
    displaySourceGroupIndices,
    sourceGroupCount: groupCounts.length,
    displayGroupHeaders,
    displayGroupMeta,
    displayGroupCount: displayGroupCounts.length,
    hasPinnedContent,
    collapseLabelVariant: groupChat?.enabled ? "agents" : "agent",
    turnPaginationEnabled,
    collapseTailWhenIdle,
    hideUserMessage: hideGroupUserMessage,
    defaultTurnCollapsed,
    turnCollapseInteractionAtRef,
    onEditSubmit: mutationActionsDisabled ? undefined : handleEditUserMessage,
    onRestoreCheckpoint: mutationActionsDisabled
      ? undefined
      : handleHeaderRestoreCheckpoint,
  });

  const activePinnedDisplayGroupIndex =
    activePinnedGroupIndex < displayGroupHeaders.length
      ? activePinnedGroupIndex
      : 0;
  const activePinnedHeader = displayGroupHeaders[activePinnedDisplayGroupIndex];
  const activePinnedMeta = displayGroupMeta[activePinnedDisplayGroupIndex];
  const activePinnedSourceGroupIndex =
    displaySourceGroupIndices[activePinnedDisplayGroupIndex];
  const hasPinnedHeaderContent =
    displayTotalFlatItems > 0 ||
    (turnPaginationEnabled && Boolean(activePinnedHeader));
  const showPinnedTurnHeader =
    hasPinnedHeaderContent &&
    !turnPageListOpen &&
    !agentOrgOverviewOpen &&
    (turnPaginationEnabled || activeGroupPinned);
  const showTurnContextRow =
    turnPaginationEnabled ||
    Boolean(agentOrgCurrentMemberName) ||
    Boolean(agentOrgOverviewPanel);
  const pinnedHeaderLayer = (
    <ChatPinnedHeaderLayer
      showTurnContextRow={showTurnContextRow}
      agentName={agentOrgCurrentMemberName}
      currentMemberId={agentOrgCurrentMemberId}
      agentOrgMembers={agentOrgMembers}
      agentOrgOverviewPanel={agentOrgOverviewPanel}
      agentOrgOverviewOpen={agentOrgOverviewOpen}
      setAgentOrgOverviewOpen={setAgentOrgOverviewOpen}
      onAgentOrgMemberSelect={onAgentOrgMemberSelect}
      onAgentOrgRunViewRefresh={onAgentOrgRunViewRefresh}
      turnPaginationEnabled={turnPaginationEnabled}
      turnPaginationReady={turnPaginationReady}
      turnPageListOpen={turnPageListOpen}
      setTurnPageListOpen={setTurnPageListOpen}
      turnPageSortAscending={turnPageSortAscending}
      setTurnPageSortAscending={setTurnPageSortAscending}
      currentTurnPageLabel={currentTurnPageLabel}
      currentTurnPageTimeLabel={currentTurnPageTimeLabel}
      currentPageIndex={currentPageIndex}
      pageCount={pageCount}
      onPreviousTurnPage={handlePreviousTurnPage}
      onNextTurnPage={handleNextTurnPage}
      onLastTurnPage={handleLastTurnPage}
      trailingActions={paginationTrailingSlot}
      groupChatViewAvailable={groupChatViewAvailable}
      groupChatViewActive={groupChatViewActive}
      onGroupChatViewToggle={onGroupChatViewToggle}
      showPinnedTurnHeader={showPinnedTurnHeader}
      sessionId={activeId}
      sourceGroupIndex={activePinnedSourceGroupIndex}
      sourceGroupCount={groupCounts.length}
      header={activePinnedHeader}
      meta={activePinnedMeta}
      hasPinnedContent={hasPinnedContent}
      collapseLabelVariant={groupChat?.enabled ? "agents" : "agent"}
      collapseTailWhenIdle={collapseTailWhenIdle}
      hideUserMessage={hideGroupUserMessage}
      defaultTurnCollapsed={defaultTurnCollapsed}
      turnCollapseInteractionAtRef={turnCollapseInteractionAtRef}
      onEditSubmit={
        mutationActionsDisabled ? undefined : handlePinnedEditSubmit
      }
      onRestoreCheckpoint={
        mutationActionsDisabled ? undefined : handleHeaderRestoreCheckpoint
      }
    />
  );

  // ============================================
  // Render
  // ============================================

  return (
    <ChatHistoryDisplayModeProvider value={displayMode}>
      <div
        className="wp__chat__history relative z-20 flex h-full min-w-0 max-w-full flex-1 flex-col self-stretch overflow-hidden"
        data-testid="chat-message-list"
        data-chat-history-count={chatHistory.length}
        data-optimized-count={optimizedChatHistory.length}
        data-flat-count={displayTotalFlatItems}
        data-group-counts={displayGroupCounts.join(",")}
        ref={chatContainerRef as React.RefObject<HTMLDivElement>}
        style={
          {
            minHeight: 0,
            fontSize: `${chatFontSize}px`,
            lineHeight: chatLineHeight ?? 1.6,
            "--chat-font-size": `${chatFontSize}px`,
            "--chat-code-font-size": `${chatCodeFontSize ?? 13}px`,
            "--chat-line-height": chatLineHeight ?? 1.6,
          } as React.CSSProperties
        }
      >
        <div
          className={`flex items-center justify-between ${DETAIL_PANEL_TOKENS.contentWidth}`}
        >
          <SessionHeader sessionInfo={sessionInfo} />
        </div>

        <ChatSearchBar
          ref={searchBarRef}
          search={search}
          isVisible={isSearchVisible}
          onClose={handleCloseSearch}
        />

        {pinnedHeaderPortalHost
          ? createPortal(pinnedHeaderLayer, pinnedHeaderPortalHost)
          : pinnedHeaderLayer}

        <div className="flex min-h-0 flex-1 flex-col">
          {agentOrgOverviewOpen && agentOrgOverviewPanel && (
            <div
              className={`max-h-[45%] flex-shrink-0 overflow-y-auto scrollbar-hide ${surfaceBgClass}`}
            >
              <div
                className={`mx-auto w-full px-2 pb-2 ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
              >
                <div
                  data-agent-org-overview-panel="true"
                  className={`${DROPDOWN_CLASSES.panel} p-1`}
                >
                  {agentOrgOverviewPanel}
                </div>
              </div>
            </div>
          )}

          <div
            className="relative min-h-0 flex-1"
            style={{
              backfaceVisibility: "hidden",
              contain: "layout paint",
              transform: "translateZ(0)",
              willChange: "transform",
            }}
            data-chat-virtualized-body-layer
          >
            {turnPageListOpen && turnPaginationReady && (
              <TurnPageList
                surfaceBgClass={surfaceBgClass}
                pages={pages}
                groupHeaders={groupHeaders}
                groupMeta={groupMeta}
                currentPageIndex={currentPageIndex}
                turnPageSortAscending={turnPageSortAscending}
                onSelectTurnPage={selectTurnPage}
              />
            )}

            {isLoadingMore && (
              <div
                className={`absolute left-0 right-0 top-0 z-20 flex items-center justify-center ${surfaceBgClass} py-2 ${DETAIL_PANEL_TOKENS.contentMaxWidth} mx-auto`}
              >
                <Loader2
                  size={SPINNER_TOKENS.default}
                  className="animate-spin text-text-3"
                />
                <span className="ml-2 text-xs text-text-3">
                  {t("placeholders.loadingHistory")}
                </span>
              </div>
            )}

            {bottomInset > 0 && (
              <div
                className="pointer-events-none absolute bottom-0 left-0 right-0 z-10"
                style={{
                  height: bottomInset,
                  maskImage: `linear-gradient(to bottom, transparent 0, black ${BOTTOM_OVERLAY_FADE_PX}px)`,
                  WebkitMaskImage: `linear-gradient(to bottom, transparent 0, black ${BOTTOM_OVERLAY_FADE_PX}px)`,
                }}
              >
                <div className={`h-full w-full ${surfaceBgClass}`} />
              </div>
            )}

            <div
              ref={scrollAreaRef}
              className="absolute inset-0 overflow-hidden"
            >
              <div
                className={`mx-auto h-full w-full ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
              >
                {optimizedChatHistory.length > 0 ? (
                  <>
                    <PlanningIndicatorBridge
                      planningIndicatorScope={planningIndicatorScope}
                      planningIndicatorEnabled={planningIndicatorEnabled}
                      onPlanningIndicatorCount={handlePlanningIndicatorCount}
                      flatItems={displayFlatItems}
                      groupCounts={displayGroupCounts}
                      totalFlatItems={displayTotalFlatItems}
                      lastAssistantFlatIndexPerItem={
                        displayLastAssistantFlatIndexPerItem
                      }
                      codeBlockContainerWidth={codeBlockContainerWidth ?? 0}
                      footerSpacerHeight={footerSpacerHeight}
                      virtualListRef={virtualListRef}
                      virtualListDataKey={virtualListDataKey}
                      getIsWpGeneWorking={getIsWpGeneWorking}
                      getIsExploring={getIsExploring}
                      renderGroupHeader={
                        turnPaginationEnabled
                          ? renderNoGroupHeader
                          : renderGroupHeader
                      }
                      onAtBottomStateChange={handleAtBottomStateChange}
                      onRangeChanged={handleRangeChanged}
                      onActiveGroupIndexChange={handleActiveGroupIndexChange}
                      onEndReached={handleTurnPageEndReached}
                      onRegenerate={
                        mutationActionsDisabled
                          ? undefined
                          : handleRegenerateGroup
                      }
                      onSubmit={memoizedSubmit}
                      onSkip={stableHandleIgnoreQuestion}
                      onEditUserMessage={
                        mutationActionsDisabled
                          ? undefined
                          : handleEditUserMessage
                      }
                      virtualScrollerRef={virtuosoScrollerRef}
                      staticScrollerRef={staticScrollerRef}
                      newEventDividerLabel={newEventDividerLabel}
                    />
                  </>
                ) : (
                  <div className="flex h-full min-h-0 flex-col">
                    {hasPinnedContent && (
                      <div
                        className={`${DETAIL_PANEL_TOKENS.contentWidth} px-3 pb-2 pt-1`}
                      >
                        <ChatPinnedBars />
                      </div>
                    )}
                    <div className="min-h-0 flex-1">
                      <ChatHistoryEmptyState
                        sessionLoadStatus={sessionLoadStatus}
                        sessionLoadError={sessionLoadError}
                        emptyConfirmed={emptyConfirmed}
                        shouldShowEmpty={shouldShowEmpty}
                        isRolledBack={isRolledBack}
                        onReload={handleReloadSession}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        <RevertConfirmDialog />
      </div>
    </ChatHistoryDisplayModeProvider>
  );
};

ChatHistory.displayName = "ChatHistory";

export default ChatHistory;
