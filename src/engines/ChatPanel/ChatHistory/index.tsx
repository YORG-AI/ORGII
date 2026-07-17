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
import { streamingDeltaContentAtom } from "@src/engines/SessionCore/core/atoms";
import { derivedSnapshotAtom } from "@src/engines/SessionCore/core/atoms/events";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms/metadata";
import { usePlanningIndicator } from "@src/engines/SessionCore/hooks";
import { addressRunActiveAtom } from "@src/features/Org2Cloud/addressCommentsRun";
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
import TurnMetadataLoader from "./components/TurnMetadataLoader";
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
  const planningFooterMode = isAgentTyping ? "agentTyping" : "planning";
  const visibleCount = planningIndicatorEnabled
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
const CHAT_MINIMAP_ROW_HEIGHT_PX = 18;
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
  const chatHistoryContainerStyle = useMemo(
    () =>
      ({
        fontSize: `${chatFontSize}px`,
        lineHeight: chatLineHeight ?? 1.6,
        "--chat-font-size": `${chatFontSize}px`,
        "--chat-code-font-size": `${chatCodeFontSize ?? 13}px`,
        "--chat-line-height": chatLineHeight ?? 1.6,
      }) as React.CSSProperties,
    [chatFontSize, chatCodeFontSize, chatLineHeight]
  );
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
  const displayTurnIds = useMemo(
    () => displayGroupMeta.map((meta) => meta.turnId),
    [displayGroupMeta]
  );
  const turnMetadataReloadKey = `${activeId ?? ""}:${displayTurnIds.length}:${
    isAgentWorking ? "working" : "idle"
  }`;
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
  const [activeMinimapAnchorFlatIndex, setActiveMinimapAnchorFlatIndex] =
    useState(0);
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

  const minimapItems = useMemo(
    () =>
      buildChatMinimapItemsFromSession(
        optimizedChatHistory,
        originalToFlatIndex
      ),
    [optimizedChatHistory, originalToFlatIndex]
  );
  const minimapActiveIndex = useMemo(
    () =>
      resolveChatMinimapActiveMarkerIndex(
        minimapItems,
        activeMinimapAnchorFlatIndex
      ),
    [activeMinimapAnchorFlatIndex, minimapItems]
  );
  const minimapScrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const activeOrder = minimapItems.findIndex(
      (item) => item.markerIndex === minimapActiveIndex
    );
    const scroller = minimapScrollerRef.current;
    if (!scroller || activeOrder < 0) return;
    // # 小地图跟随：长会话里让当前浏览标记尽量留在小地图中线，避免红点跑出视野。
    scroller.scrollTo({
      top:
        activeOrder * CHAT_MINIMAP_ROW_HEIGHT_PX -
        scroller.clientHeight / 2 +
        CHAT_MINIMAP_ROW_HEIGHT_PX / 2,
      behavior: "smooth",
    });
  }, [minimapActiveIndex, minimapItems]);

  const scrollToDisplayFlatIndex = useCallback(
    (flatIndex: number) => {
      // # 小地图标记的 flatIndex 永远来自全 session flatItems；displayFlatItems 只负责当前页渲染。
      // # 点击跨页标记时先切到所属页，再把全局 flat index 转成本页 display flat index 居中滚动。
      const targetPageIndex = pages.findIndex(
        (page) =>
          flatIndex >= page.flatStartIndex && flatIndex < page.flatEndIndex
      );
      const targetPage = targetPageIndex >= 0 ? pages[targetPageIndex] : null;
      if (turnPaginationEnabled && targetPage) {
        setTurnPageSelection({
          pageIndex: targetPageIndex,
          sessionId: activeId,
        });
        window.requestAnimationFrame(() => {
          virtualListRef.current?.scrollToIndex?.(
            buildChatMinimapJumpRequest(flatIndex - targetPage.flatStartIndex)
          );
        });
        return;
      }
      virtualListRef.current?.scrollToIndex?.(
        buildChatMinimapJumpRequest(flatIndex)
      );
    },
    [
      activeId,
      pages,
      setTurnPageSelection,
      turnPaginationEnabled,
      virtualListRef,
    ]
  );

  const handleMinimapJump = useCallback(
    (flatIndex: number) => {
      // # 小地图点击复用轮次列表的展示下标滚动路径：同一个 scrollToIndex + center 对齐，避免出现两套定位语义。
      scrollToDisplayFlatIndex(flatIndex);
      setActiveMinimapAnchorFlatIndex(flatIndex);
    },
    [scrollToDisplayFlatIndex]
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
        data-optimized-count={activeProjectionHistory.length}
        data-flat-count={displayTotalFlatItems}
        data-group-shape={projection.groupShapeDigest}
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
                    <TurnMetadataLoader
                      sessionId={activeId}
                      reloadKey={turnMetadataReloadKey}
                      turnIds={displayTurnIds}
                    />
                    <PlanningIndicatorBridge
                      planningIndicatorScope={planningIndicatorScope}
                      planningIndicatorEnabled={planningIndicatorEnabled}
                      onPlanningIndicatorCount={handlePlanningIndicatorCount}
                      flatItems={displayFlatItems}
                      groupCounts={displayGroupCounts}
                      turnIds={displayTurnIds}
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
                      onRangeChanged={(range) => {
                        handleRangeChanged(range);
                        // # 当前浏览位置：选择虚拟列表可见范围中心线及以下第一项作为当前上下文锚点；再映射到唯一小地图 marker。
                        const visibleFlatIndex = Math.ceil(
                          (range.startIndex + range.endIndex) / 2
                        );
                        // # 小地图的唯一数据源是全 session flatItems；分页时虚拟列表 range 是当前页内下标，
                        // # 必须加回当前页的全局起点，红色 active 才会落到全局小地图对应轮次。
                        setActiveMinimapAnchorFlatIndex(
                          turnPaginationEnabled
                            ? (pages[currentPageIndex]?.flatStartIndex ?? 0) +
                                visibleFlatIndex
                            : visibleFlatIndex
                        );
                      }}
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
            <ChatMinimap
              ref={minimapScrollerRef}
              items={minimapItems}
              activeMarkerIndex={minimapActiveIndex}
              onJump={handleMinimapJump}
            />
          </div>
        </div>
        <RevertConfirmDialog />
      </div>
    </ChatHistoryDisplayModeProvider>
  );
};

export interface ChatMinimapItem {
  flatIndex: number;
  /** 小地图标记唯一序号；active 只能用它判断，不能用可能因折叠映射重合的 flatIndex。 */
  markerIndex: number;
  /** 轮次号；同一轮的 user/agent 标记共用同一个编号。 */
  turnNumber: number;
  /** 兼容旧调用方/测试快照；等同于 turnNumber。 */
  order: number;
  kind: "user" | "agent";
  roleLabel: "user" | "agent";
  timeLabel: string;
  /** 该标记覆盖的展示 flat index 闭区间终点，用于把视口锚点映射回所属轮次段。 */
  endFlatIndex: number;
}

export interface ChatMinimapProps {
  items: readonly ChatMinimapItem[];
  activeMarkerIndex: number;
  onJump: (flatIndex: number) => void;
}

export const ChatMinimap = React.forwardRef<HTMLDivElement, ChatMinimapProps>(
  ({ items, activeMarkerIndex, onJump }, ref) => (
    <div
      ref={ref}
      data-testid="chat-minimap"
      className="absolute right-2 top-4 z-[80] flex max-h-[calc(100%-2rem)] w-14 flex-col items-center overflow-y-auto overflow-x-visible rounded-xl bg-chat-pane/70 py-1 shadow-sm backdrop-blur-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="聊天小地图"
      data-minimap-count={items.length}
    >
      {items.map((item) => {
        const isActive = item.markerIndex === activeMarkerIndex;
        return (
          <button
            key={item.markerIndex}
            type="button"
            title={`#${item.turnNumber} · ${item.roleLabel} · ${item.timeLabel}`}
            aria-label={`跳转到第 ${item.turnNumber} 轮 ${item.roleLabel} 消息`}
            data-testid="chat-minimap-marker"
            data-kind={item.kind}
            data-active={isActive ? "true" : "false"}
            data-jump-index={item.flatIndex}
            className="group flex h-[18px] w-full shrink-0 items-center justify-center gap-1 rounded-sm transition-colors hover:bg-fill-2/80"
            onClick={() => onJump(item.flatIndex)}
          >
            <span
              className="block rounded-full transition-all group-hover:h-2.5 group-hover:w-2.5"
              style={{
                height: isActive ? 12 : 7,
                width: isActive ? 12 : 7,
                backgroundColor: isActive
                  ? "#B56B6B"
                  : item.kind === "user"
                    ? "#7A9E9F"
                    : "#C7A27C",
                boxShadow: isActive
                  ? "0 0 0 2px rgba(181, 107, 107, 0.24)"
                  : undefined,
              }}
            />
            {isActive && (
              <span
                data-active-label="true"
                className="min-w-5 whitespace-nowrap text-left text-[9px] font-medium leading-none text-text-2"
              >
                #{item.turnNumber}
              </span>
            )}
          </button>
        );
      })}
    </div>
  )
);

ChatMinimap.displayName = "ChatMinimap";

export function resolveChatMinimapActiveMarkerIndex(
  items: readonly ChatMinimapItem[],
  viewportAnchorFlatIndex: number
): number {
  if (items.length === 0) return -1;
  const anchor = Number.isFinite(viewportAnchorFlatIndex)
    ? Math.max(0, viewportAnchorFlatIndex)
    : (items[items.length - 1]?.endFlatIndex ?? 0);
  // # active 语义：用视口中心线偏下项作为当前上下文，取这条线及以下命中的第一个 user/agent 段。
  // # 返回唯一 markerIndex，避免 user/agent 在折叠映射后 flatIndex 重合时多个红点同时 active。
  const containing = items.find(
    (item) => anchor >= item.flatIndex && anchor <= item.endFlatIndex
  );
  if (containing) return containing.markerIndex;
  const below = items.find((item) => item.flatIndex >= anchor);
  return (below ?? items[items.length - 1]).markerIndex;
}

export function buildChatMinimapJumpRequest(flatIndex: number): {
  index: number;
  align: "center";
  behavior: "smooth";
  targetLineAlign: "center-line";
} {
  return {
    index: flatIndex,
    align: "center",
    behavior: "smooth",
    targetLineAlign: "center-line",
  };
}

export function buildChatMinimapItemsFromSession(
  items: readonly OptimizedChatItem[],
  originalToFlatIndex: ReadonlyMap<number, number>
): ChatMinimapItem[] {
  // # 全局小地图必须反映整个 session 的原始对话序列，而不是当前页/折叠后的 flatItems。
  // # 因此这里从 optimizedChatHistory 扫描所有消息，再用 originalToFlatIndex 映射到可滚动的 flat index。
  const result: ChatMinimapItem[] = [];
  let currentTurn = 0;
  let pendingAgent: ChatMinimapItem | null = null;

  const resolveFlatIndex = (sourceIndex: number): number =>
    originalToFlatIndex.get(sourceIndex) ?? sourceIndex;

  const flushAgent = () => {
    if (!pendingAgent) return;
    result.push(pendingAgent);
    pendingAgent = null;
  };

  for (const [sourceIndex, item] of items.entries()) {
    const kind = getChatMinimapKind(item);
    if (!kind) continue;
    const flatIndex = resolveFlatIndex(sourceIndex);
    if (kind === "user") {
      flushAgent();
      currentTurn += 1;
      result.push(
        createChatMinimapItem({
          flatIndex,
          endFlatIndex: flatIndex,
          turnNumber: currentTurn,
          kind,
          item,
        })
      );
      continue;
    }

    if (currentTurn === 0) continue;
    if (!pendingAgent) {
      pendingAgent = createChatMinimapItem({
        flatIndex,
        endFlatIndex: flatIndex,
        turnNumber: currentTurn,
        kind: "agent",
        item,
      });
    } else {
      pendingAgent.endFlatIndex = Math.max(
        pendingAgent.endFlatIndex,
        flatIndex
      );
    }
  }
  flushAgent();
  return assignChatMinimapMarkerIndices(result);
}

export function buildChatMinimapItems(
  items: readonly OptimizedChatItem[],
  _groupCounts?: readonly number[],
  _groupHeaders?: readonly (OptimizedChatItem | null)[]
): ChatMinimapItem[] {
  // # displayGroupCounts/displayGroupHeaders 是虚拟列表分组/折叠分页语义，不是可靠轮次语义；
  // # 真实长会话可能被合成 1-2 个 display group，按它建小地图会只剩 1-2 个标记。
  // # 因此小地图永远按最终展示消息序列扫描 role：user 开新轮，后续非 user 合并为 agent 段。
  return buildChatMinimapItemsFromRoles(items);
}

function buildChatMinimapItemsFromRoles(
  items: readonly OptimizedChatItem[]
): ChatMinimapItem[] {
  const result: ChatMinimapItem[] = [];
  let currentTurn = 0;
  let pendingAgent: ChatMinimapItem | null = null;

  const flushAgent = () => {
    if (!pendingAgent) return;
    result.push(pendingAgent);
    pendingAgent = null;
  };

  for (const [flatIndex, item] of items.entries()) {
    const kind = getChatMinimapKind(item);
    if (!kind) continue;
    if (kind === "user") {
      flushAgent();
      currentTurn += 1;
      result.push(
        createChatMinimapItem({
          flatIndex,
          endFlatIndex: flatIndex,
          turnNumber: currentTurn,
          kind,
          item,
        })
      );
      continue;
    }

    if (currentTurn === 0) continue;
    if (!pendingAgent) {
      pendingAgent = createChatMinimapItem({
        flatIndex,
        endFlatIndex: flatIndex,
        turnNumber: currentTurn,
        kind: "agent",
        item,
      });
    } else {
      pendingAgent.endFlatIndex = flatIndex;
    }
  }
  flushAgent();
  return assignChatMinimapMarkerIndices(result);
}

function assignChatMinimapMarkerIndices(
  items: ChatMinimapItem[]
): ChatMinimapItem[] {
  return items.map((item, markerIndex) => ({ ...item, markerIndex }));
}

function createChatMinimapItem({
  flatIndex,
  endFlatIndex,
  turnNumber,
  kind,
  item,
}: {
  flatIndex: number;
  endFlatIndex: number;
  turnNumber: number;
  kind: "user" | "agent";
  item: OptimizedChatItem | undefined | null;
}): ChatMinimapItem {
  return {
    flatIndex,
    markerIndex: -1,
    endFlatIndex,
    turnNumber,
    order: turnNumber,
    kind,
    roleLabel: kind,
    // # tooltip 时间：真实 displayFlatItems 可能把时间放在 event/message/顶层任一路径。
    timeLabel: getChatItemTimestamp(item) ?? "—",
  };
}

function getChatMinimapKind(
  item: OptimizedChatItem | undefined
): "user" | "agent" | null {
  const rawRole = getChatItemRole(item);
  if (/user|human/i.test(rawRole)) return "user";
  if (
    /assistant|agent|tool|result|system|function|observation|activity/i.test(
      rawRole
    )
  ) {
    return "agent";
  }
  // # 兼容真实 OptimizedChatItem：工具/活动分组常只有 type/kind，没有 event.role；
  // # 这些都是 user 之后的 agent 段，不能因为 role 缺失把小地图清空。
  const fallbackType = String(
    readFirstString(item, ["type", "kind", "event.actionType"])
  );
  if (fallbackType && !/threadSelector|structural/i.test(fallbackType))
    return "agent";
  return null;
}

function getChatItemRole(item: OptimizedChatItem | undefined): string {
  return String(
    readFirstString(item, [
      "role",
      "source",
      "message.role",
      "message.source",
      "message.type",
      "event.role",
      "event.source",
      "event.actionType",
      "event.type",
      "event.kind",
      "type",
      "kind",
    ]) ?? ""
  );
}

function getChatItemTimestamp(
  item: OptimizedChatItem | null | undefined
): string | undefined {
  return readFirstString(item, [
    "created_at",
    "createdAt",
    "timestamp",
    "message.created_at",
    "message.createdAt",
    "message.timestamp",
    "event.created_at",
    "event.createdAt",
    "event.timestamp",
  ]);
}

function readFirstString(
  value: unknown,
  paths: readonly string[]
): string | undefined {
  for (const path of paths) {
    const found = readPath(value, path);
    if (typeof found === "string" && found.length > 0) return found;
  }
  return undefined;
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

ChatHistory.displayName = "ChatHistory";

export default ChatHistory;
