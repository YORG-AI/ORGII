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
import { manualCompactInFlightSessionAtom } from "@src/engines/ChatPanel/hooks/useManualCompact";
import { streamingDeltaContentAtom } from "@src/engines/SessionCore/core/atoms";
import { derivedSnapshotAtom } from "@src/engines/SessionCore/core/atoms/events";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms/metadata";
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
import { selectedExecutionThreadAtom } from "@src/store/ui/sessionPaginationAtom";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";

import SessionHeader from "../ChatItems/SessionHeader";
import { useChatSessionId } from "../ChatSessionContext";
import { useGroupChatContext } from "./GroupChatView/GroupChatContext";
import { isAgentOrgInboxTranscriptEvent } from "./GroupChatView/groupChatUtils";
import { ChatHistoryDisplayModeProvider } from "./chatDisplayModeContext";
import type { OptimizedChatItem } from "./chatItemPipeline/types";
import ChatHistoryEmptyState from "./components/ChatHistoryEmptyState";
import ChatHistoryList from "./components/ChatHistoryList";
import ChatPinnedHeaderLayer from "./components/ChatPinnedHeaderLayer";
import ChatSearchBar from "./components/ChatSearchBar";
import ConversationMinimap from "./components/ConversationMinimap";
import RevertConfirmDialog from "./components/RevertConfirmDialog";
import TurnPageList from "./components/TurnPageList";
import { getChatContentBottomDistance } from "./config/chatFooterSpacer";
import {
  useChatEmptyState,
  useChatFooterSpacer,
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
import type { ChatGroupsProjectionOptions } from "./hooks/useChatGroupsProjection";
import "./index.scss";
import { useChatProjection } from "./projection/useChatProjection";

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
  "planningIndicatorCount" | "planningVariantIndex" | "planningFooterMode"
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
  const { count, variantIndex } = usePlanningIndicator(planningIndicatorScope);
  const activeSessionId = useAtomValue(sessionIdAtom);
  const streamingDeltaMap = useAtomValue(streamingDeltaContentAtom);
  const scopedSessionId = planningIndicatorScope?.sessionId ?? activeSessionId;
  const liveDelta = scopedSessionId
    ? streamingDeltaMap.get(scopedSessionId)
    : undefined;
  const isAgentTyping = liveDelta?.kind === "message";
  // Manual compaction rewrites the durable transcript off-turn, so the
  // running-turn atoms stay quiet; surface it through the same footer with
  // its own label instead of leaving the chat silent while it works.
  const compactingSessionId = useAtomValue(manualCompactInFlightSessionAtom);
  const isCompacting =
    scopedSessionId !== null && compactingSessionId === scopedSessionId;
  const planningFooterMode = isCompacting
    ? "compacting"
    : isAgentTyping
      ? "agentTyping"
      : "planning";
  const visibleCount = isCompacting
    ? 1
    : planningIndicatorEnabled
      ? isAgentTyping
        ? 1
        : count
      : 0;

  // Notify the orchestrator whenever the count flips so useChatFooterSpacer
  // can schedule a re-measurement.
  useEffect(() => {
    onPlanningIndicatorCount(visibleCount);
  }, [visibleCount, onPlanningIndicatorCount]);

  return (
    <ChatHistoryList
      {...chatHistoryListProps}
      planningIndicatorCount={visibleCount}
      planningVariantIndex={variantIndex}
      planningFooterMode={planningFooterMode}
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
const FLOATING_MINIMAP_IDLE_DELAY_MS = 1_200;

// Static GPU-layer hints for the virtualized body wrapper — never depends on
// state, so keep it as a module-level const to avoid a fresh object each render.
const VIRTUALIZED_BODY_STYLE: React.CSSProperties = {
  backfaceVisibility: "hidden",
  contain: "layout paint",
  transform: "translateZ(0)",
  willChange: "transform",
};

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
  cancelAddToConversationLabel: string;
  onAddToConversation: () => void;
  onCancelAddToConversation: () => void;
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
    cancelAddToConversationLabel: "",
    onAddToConversation: () => undefined,
    onCancelAddToConversation: () => undefined,
  };

interface ChatHistoryProps {
  /** Opaque background class for sticky headers. Must match the container surface. */
  surfaceBgClass?: string;
  /** Dock side of the containing chat panel, used by narrow side previews. */
  chatPanelPosition?: "left" | "right";
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
  chatPanelPosition = "right",
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
    cancelAddToConversationLabel,
    onAddToConversation,
    onCancelAddToConversation,
  } = browserAddToConversationNav;

  const isAgentWorking = useAtomValue(isSessionActiveAtom);
  const [tailIdleReadyKey, setTailIdleReadyKey] = useState<string | null>(null);
  const turnCollapseOverrides = useAtomValue(turnCollapseOverrideAtom);
  const collapseAllCommand = useAtomValue(collapseAllCommandAtom);

  const selectedThreadId = useAtomValue(selectedExecutionThreadAtom);
  const derivedSnapshot = useAtomValue(derivedSnapshotAtom);
  const snapshotSessionId =
    derivedSnapshot?.lastEvent?.sessionId ??
    derivedSnapshot?.chatEvents[0]?.sessionId ??
    null;
  const hasAuthoritativeSourceVersion =
    derivedSnapshot !== null && snapshotSessionId === activeId;
  const sourceVersion = hasAuthoritativeSourceVersion
    ? derivedSnapshot.version
    : chatHistory.length;
  const groupChat = useGroupChatContext();

  const sessionInfo = useMemo(() => {
    const start = chatHistory.find(
      (event) => event.actionType === "session_start"
    );
    if (!start) return null;
    return {
      sessionId: start.sessionId,
      model:
        (start.args?.model as string) || (start.result?.model as string) || "",
      startedAt: start.createdAt,
    };
  }, [chatHistory]);
  const tailTurnId = useMemo(() => {
    for (let index = chatHistory.length - 1; index >= 0; index--) {
      const event = chatHistory[index];
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
  }, [chatHistory, groupChat]);

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
  // variantIndex stays inside PlanningIndicatorBridge.
  const [planningIndicatorCount, setPlanningIndicatorCount] = useState<0 | 1>(
    0
  );
  const handlePlanningIndicatorCount = useCallback((count: 0 | 1) => {
    setPlanningIndicatorCount((previous) =>
      previous === count ? previous : count
    );
  }, []);

  // Completed historical turns should start collapsed. `forceCollapseAllTurns`
  // additionally makes the live tail eligible immediately for compact
  // read-only subagent panes.
  const defaultTurnCollapsed = true;

  // --- Grouping for virtualized chat rows ---
  //
  // `useChatGroups` applies the shared "Agent worked for …" collapse
  // STRUCTURALLY: collapsed turns drop all but their final assistant
  // message before flatItems/groupCounts are returned. Hiding items inline
  // leaves virtualization measurement caches stuck at pre-collapse heights,
  // which shows up as a tall blank tail beneath the surviving last reply.
  const groupOptions = useMemo<ChatGroupsProjectionOptions>(
    () => ({
      collapseOverrides: turnCollapseOverrides,
      isAgentWorking,
      collapseTailWhenIdle,
      forceCollapseAllTurns,
      defaultTurnCollapsed,
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
      defaultTurnCollapsed,
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
    sourceVersion,
    events: chatHistory,
    options: projectionOptions,
    enabled: hasAuthoritativeSourceVersion,
  });
  const activeProjectionHistory = projection.optimizedChatHistory;
  const projectedGroups = projection.groups;
  const {
    groupCounts,
    groupHeaders,
    groupMeta,
    flatItems,
    totalFlatItems,
    originalToFlatIndex,
    lastGroupFirstFlatIndex: _lastGroupFirstFlatIndex,
    lastAssistantFlatIndexPerItem,
  } = projectedGroups ?? {
    groupCounts: [],
    groupHeaders: [],
    groupMeta: [],
    flatItems: [],
    totalFlatItems: 0,
    originalToFlatIndex: new Map<number, number>(),
    lastGroupFirstFlatIndex: null,
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
  const virtualListGroupShapeKey = projection.groupShapeDigest;
  const virtualListItemShapeKey = projection.itemShapeDigest;
  const virtualListDataKey = `${activeId ?? "no-session"}:${
    turnPaginationEnabled ? `page-${currentPageIndex}` : "all"
  }:${virtualListGroupShapeKey}:${virtualListItemShapeKey}:${collapseStateKey}`;
  const tailFollowKey = useMemo(() => {
    const tailItem = displayFlatItems[displayFlatItems.length - 1];
    const tailEvent = tailItem?.event;
    return [
      activeId ?? "no-session",
      tailItem?.chunk_id ?? "no-tail",
      tailEvent?.displayStatus ?? "",
      tailEvent?.activityStatus ?? "",
      tailEvent?.displayText?.length ?? 0,
      displayTotalFlatItems,
      planningIndicatorCount,
    ].join(":");
  }, [
    activeId,
    displayFlatItems,
    displayTotalFlatItems,
    planningIndicatorCount,
  ]);

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
    optimizedChatHistory: activeProjectionHistory,
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
  const [activeGroupIndex, setActiveGroupIndex] = useState(0);
  const [visibleGroupIndices, setVisibleGroupIndices] = useState<number[]>([]);
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
  useEffect(() => {
    setActiveGroupIndex((previousIndex) =>
      Math.min(previousIndex, Math.max(0, displayGroupCounts.length - 1))
    );
    setVisibleGroupIndices((previousIndices) =>
      previousIndices.filter(
        (groupIndex) => groupIndex < displayGroupCounts.length
      )
    );
  }, [activeId, currentPageIndex, displayGroupCounts.length]);
  const handleConversationMinimapNavigate = useCallback(
    (groupIndex: number) => {
      virtualListRef.current?.scrollToGroup({
        groupIndex,
        behavior: "smooth",
      });
    },
    [virtualListRef]
  );
  const conversationHistoryPageIndex = useMemo(() => {
    if (turnPaginationEnabled) return currentPageIndex;
    const pageIndex = pages.findIndex(
      (page) =>
        activeGroupIndex >= page.startGroupIndex &&
        activeGroupIndex <= page.endGroupIndex
    );
    return pageIndex >= 0 ? pageIndex : Math.max(0, pages.length - 1);
  }, [activeGroupIndex, currentPageIndex, pages, turnPaginationEnabled]);
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
      if (groupIndex !== undefined) {
        handleConversationMinimapNavigate(groupIndex);
      }
    },
    [handleConversationMinimapNavigate, pages, setTurnPageListOpen]
  );

  // Shared scroll intent refs — owned here, passed into scroll hooks so
  // they coordinate without re-renders.
  const pinLastGroupRef = useRef(false);
  const manualScrollAtRef = useRef(0);
  const programmaticScrollAtRef = useRef(0);
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
      optimizedChatHistoryLength: activeProjectionHistory.length,
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

        const nextVisible =
          getChatContentBottomDistance({
            scrollTop: root.scrollTop,
            scrollHeight: root.scrollHeight,
            clientHeight: root.clientHeight,
            footerSpacerHeight,
            bottomInset,
          }) <= SCROLL_NAV_SHOW_THRESHOLD_PX;
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
    bottomInset,
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
    programmaticScrollAtRef,
    turnCollapseInteractionAtRef,
    isContentOverflowingRef,
    activeSessionId: activeId,
    staticScrollerRef,
    footerSpacerHeight,
    bottomInset,
    tailFollowKey,
    alwaysFollowTail: disableTailCollapse,
  });
  const [conversationMinimapScrolling, setConversationMinimapScrolling] =
    useState(false);
  const conversationMinimapIdleTimerRef = useRef<number | null>(null);
  const handleChatListScrollStateChange = useCallback(
    (nextAtBottom: boolean) => {
      handleAtBottomStateChange(nextAtBottom);
      setConversationMinimapScrolling(true);
      if (conversationMinimapIdleTimerRef.current !== null) {
        window.clearTimeout(conversationMinimapIdleTimerRef.current);
      }
      conversationMinimapIdleTimerRef.current = window.setTimeout(() => {
        conversationMinimapIdleTimerRef.current = null;
        setConversationMinimapScrolling(false);
      }, FLOATING_MINIMAP_IDLE_DELAY_MS);
    },
    [handleAtBottomStateChange]
  );
  useEffect(
    () => () => {
      if (conversationMinimapIdleTimerRef.current !== null) {
        window.clearTimeout(conversationMinimapIdleTimerRef.current);
      }
    },
    []
  );
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
    footerSpacerHeight,
    bottomInset,
    sessionLoadStatus,
    virtuosoScrollerRef,
    atBottom,
    isPendingCancelRef,
    isContentOverflowingRef,
    optimizedChatHistoryLength: activeProjectionHistory.length,
    pinLastGroupRef,
    manualScrollAtRef,
    programmaticScrollAtRef,
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
      cancelAddToConversationLabel,
      onAddToConversation,
      onCancelAddToConversation,
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
    cancelAddToConversationLabel,
    onAddToConversation,
    onCancelAddToConversation,
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
      sourceGroupIndex={activePinnedSourceGroupIndex}
      sourceGroupCount={groupCounts.length}
      header={activePinnedHeader}
      meta={activePinnedMeta}
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

  const chatHistoryContainerStyle = useMemo<React.CSSProperties>(
    () =>
      ({
        minHeight: 0,
        fontSize: `${chatFontSize}px`,
        lineHeight: chatLineHeight ?? 1.6,
        "--chat-font-size": `${chatFontSize}px`,
        "--chat-code-font-size": `${chatCodeFontSize ?? 13}px`,
        "--chat-line-height": chatLineHeight ?? 1.6,
      }) as React.CSSProperties,
    [chatFontSize, chatCodeFontSize, chatLineHeight]
  );

  return (
    <ChatHistoryDisplayModeProvider value={displayMode}>
      <div
        className="wp__chat__history relative z-20 flex h-full min-w-0 max-w-full flex-1 flex-col self-stretch overflow-hidden"
        data-testid="chat-message-list"
        data-chat-history-count={chatHistory.length}
        data-optimized-count={activeProjectionHistory.length}
        data-flat-count={displayTotalFlatItems}
        data-group-shape={projection.groupShapeDigest}
        ref={chatContainerRef as React.RefObject<HTMLDivElement>}
        style={chatHistoryContainerStyle}
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
          ? createPortal(
              <div
                className="chat-history-portal"
                style={chatHistoryContainerStyle}
              >
                {pinnedHeaderLayer}
              </div>,
              pinnedHeaderPortalHost
            )
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
            className="relative min-h-0 flex-1 @container/chatbody"
            style={VIRTUALIZED_BODY_STYLE}
            data-chat-virtualized-body-layer
          >
            {!turnPaginationEnabled &&
              !turnPageListOpen &&
              !agentOrgOverviewOpen && (
                <ConversationMinimap
                  groupHeaders={displayGroupHeaders}
                  groupMeta={displayGroupMeta}
                  groupCounts={displayGroupCounts}
                  flatItems={displayFlatItems}
                  chatPanelPosition={chatPanelPosition}
                  activeGroupIndex={activeGroupIndex}
                  visibleGroupIndices={visibleGroupIndices}
                  isAtBottom={atBottom}
                  isScrolling={conversationMinimapScrolling}
                  labelVariant={groupChat?.enabled ? "agents" : "agent"}
                  onNavigate={handleConversationMinimapNavigate}
                  onHistoryToggle={handleConversationHistoryToggle}
                />
              )}

            {turnPageListOpen &&
              (turnPaginationEnabled
                ? turnPaginationReady
                : pages.length > 0) && (
                <TurnPageList
                  surfaceBgClass={surfaceBgClass}
                  bottomInset={bottomInset}
                  pages={pages}
                  groupHeaders={groupHeaders}
                  groupMeta={groupMeta}
                  currentPageIndex={conversationHistoryPageIndex}
                  turnPageSortAscending={turnPageSortAscending}
                  onSelectTurnPage={
                    turnPaginationEnabled
                      ? selectTurnPage
                      : handleConversationHistorySelect
                  }
                  onToggleSort={
                    turnPaginationEnabled
                      ? undefined
                      : handleConversationHistorySortToggle
                  }
                  onClose={
                    turnPaginationEnabled
                      ? undefined
                      : handleConversationHistoryClose
                  }
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
              <div className="h-full w-full">
                {activeProjectionHistory.length > 0 ? (
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
                      bottomInset={bottomInset}
                      virtualListRef={virtualListRef}
                      virtualListDataKey={virtualListDataKey}
                      getIsWpGeneWorking={getIsWpGeneWorking}
                      getIsExploring={getIsExploring}
                      renderGroupHeader={
                        turnPaginationEnabled
                          ? renderNoGroupHeader
                          : renderGroupHeader
                      }
                      onAtBottomStateChange={handleChatListScrollStateChange}
                      onRangeChanged={handleRangeChanged}
                      onActiveGroupIndexChange={handleActiveGroupIndexChange}
                      hideActiveGroupHeader={turnPaginationEnabled}
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
                  <ChatHistoryEmptyState
                    sessionLoadStatus={sessionLoadStatus}
                    sessionLoadError={sessionLoadError}
                    emptyConfirmed={emptyConfirmed}
                    shouldShowEmpty={shouldShowEmpty}
                    isRolledBack={isRolledBack}
                    projectionPending={
                      projection.pending && chatHistory.length > 0
                    }
                    onReload={handleReloadSession}
                  />
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
