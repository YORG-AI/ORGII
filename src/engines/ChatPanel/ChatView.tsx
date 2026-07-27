/**
 * ChatView — Reusable chat content component
 *
 * Renders ChatHistory + InputArea for a given session.
 * Can be used in:
 * - Sidebar mode (inside ChatPanel)
 * - Tab mode (inside WorkStation tabs)
 *
 * Both modes write activeSessionIdAtom so that SessionSyncProvider
 * loads the correct session data into the global event store.
 * Secondary surfaces additionally null the pipeline atom on unmount
 * when they were the last claimant, so that event streaming does not
 * outlive the embedding.
 *
 * This component handles:
 * - File Review sync (via ChatInteractArea)
 * - Message queue display
 * - ChatHistory + ChatInteractArea rendering
 *
 * It does NOT handle:
 * - Sidebar positioning/resize
 * - Session tab bar / header
 * - Session creator (shown when no session)
 */
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { ArrowDown } from "lucide-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  type CoreSessionSummary,
  getOrgtrackSessionSummary,
} from "@src/api/tauri/lineage";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { useShowInteractArea } from "@src/contexts/workspace/ChatContext";
import { GroupChatPausedBanner } from "@src/engines/ChatPanel/components/ChatStatusBanners";
import { forkExternalHistoryIntoOrgiiSession } from "@src/engines/ChatPanel/externalHistoryFork";
import { useAgentOrgGroupChatController } from "@src/engines/ChatPanel/hooks/useAgentOrgGroupChatController";
import { replayModeAtom } from "@src/engines/SessionCore";
import { derivedSnapshotAtom } from "@src/engines/SessionCore/core/atoms/events";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { derivePlanApprovalViewState } from "@src/engines/SessionCore/derived/planDisplayEvents";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import { ForkCancelledError } from "@src/features/TeamCollaboration/forkSession";
import { createLogger } from "@src/hooks/logger";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import {
  activeSessionIdAtom,
  loadSessions,
  sessionByIdAtom,
} from "@src/store/session";
import {
  isSessionActiveAtom,
  restoreToInputAtom,
  streamRetryStatusAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { pendingPlanApprovalsAtom } from "@src/store/session/planApprovalAtom";
import type { SessionContinuation } from "@src/store/session/sessionTabPlacementAtom";
import type { ChatHistoryDisplayMode } from "@src/store/ui/chatPanelAtom";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import {
  STATION_MODE,
  bumpSimulatorDiffRefreshNonceAtom,
  simulatorDiffScopeRequestAtom,
  simulatorSelectedAppAtom,
  stationModeAtom,
} from "@src/store/ui/simulatorAtom";
import {
  isCursorIdeSession,
  isExternalHistorySession,
  isImportedHistorySession,
} from "@src/util/session/sessionDispatch";

import ChatFloatingComposer from "./ChatFloatingComposer";
import { type ScrollNavState } from "./ChatHistory";
import {
  CHAT_SESSION_CONTEXT_NONE,
  ChatSessionContext,
} from "./ChatSessionContext";
import { ChatViewHistorySurface } from "./ChatViewHistorySurface";
import InputArea from "./InputArea";
import GitDiffActionsMenu from "./InputArea/components/GitDiffActionsMenu";
import {
  buildCompactFilesReloadKey,
  countChatRounds,
} from "./InputArea/components/compactFileChangesHelpers";
import { useAgentOrgIntervention } from "./InputArea/components/useAgentOrgIntervention";
import { useAgentOrgMemberSessionJump } from "./InputArea/components/useAgentOrgMemberSessionJump";
import { useAgentOrgRunView } from "./InputArea/components/useAgentOrgRunView";
import { useComposerSections } from "./InputArea/hooks/useComposerSections";
import { useGitDiffActions } from "./InputArea/hooks/useGitDiffActions";
import { useCanvasForTurn } from "./blocks/CanvasInlineCard/useCanvasForTurn";
import { useJumpToSimulatorCanvas } from "./blocks/CanvasInlineCard/useJumpToSimulatorCanvas";
import { resolveInitialFileChanges } from "./chatViewFileChanges";
import { useBrowserAddToConversationAction } from "./hooks/useBrowserAddToConversationAction";
import { useChatViewMessageQueue } from "./hooks/useChatViewMessageQueue";
import { useChatViewSessionLifecycle } from "./hooks/useChatViewSessionLifecycle";
import { useFollowAgent } from "./hooks/useFollowAgent";
import { useImportedSessionSubmitOverride } from "./hooks/useImportedSessionSubmitOverride";
import type { SubmitOverrideInput } from "./hooks/useInputArea/types";

const logger = createLogger("ChatView");

const CHAT_FLOATING_COMPOSER_FALLBACK_INSET_PX = 72;

const EMPTY_CHAT_EVENTS: SessionEvent[] = [];

function formatPlanPillLabel(
  autoApproveAt: number | null | undefined,
  nowMs = Date.now()
): string {
  if (!autoApproveAt) return "Plan";
  const seconds = Math.max(0, Math.ceil((autoApproveAt - nowMs) / 1000));
  return `Plan · ${seconds}s`;
}

export interface ChatViewProps {
  /** Session ID to display. Sync bridges and events load for this session. */
  sessionId: string;
  onRegisterSearchOpen?: (handler: (() => void) | null) => void;
  displayMode?: ChatHistoryDisplayMode;
  turnPaginationEnabled?: boolean;
  /** Dock side for the containing chat panel, used to place side previews inward. */
  position?: "left" | "right";
  /** Opaque background class for sticky headers (must match the container surface).
   *  Defaults to "bg-chat-pane" (side panel). Pass EDITOR_TAB_CANVAS_BG_CLASS for WorkStation. */
  surfaceBgClass?: string;
  /**
   * Passive replay mode: this ChatView does NOT write the pipeline
   * atom AND does NOT mirror the IDE workspace folders into the
   * session's backend workspace. Use for editor-tab session inspection
   * where the chat is a read-only artifact.
   */
  readOnly?: boolean;
  /**
   * Secondary/inspect mode: this ChatView DOES claim the pipeline
   * (so live events stream and the user can interact), but does NOT
   * mutate the session's persisted backend workspace via
   * `useSessionWorkspaceSync`. Use when showing another session's
   * chat in a non-primary surface (kanban detail, project-manager
   * tab) — those sessions may belong to a totally different repo and
   * we must not silently rewrite their workspace footprint to match
   * the IDE's current folders.
   */
  secondary?: boolean;
  /**
   * Retarget the owning tab after an immutable imported history is forked
   * into a writable ORGII session. The callback must also claim/navigate the
   * new session pipeline for its surface.
   */
  onSessionContinuation?: (continuation: SessionContinuation) => void;
}

const ChatView: React.FC<ChatViewProps> = memo(
  ({
    sessionId,
    onRegisterSearchOpen,
    displayMode = "full",
    turnPaginationEnabled = true,
    position = "right",
    surfaceBgClass = "bg-chat-pane",
    readOnly = false,
    secondary = false,
    onSessionContinuation,
  }) => {
    const { t } = useTranslation("sessions");
    const { t: tNavigation } = useTranslation("navigation");
    const store = useStore();
    const { openSession } = useSessionView();
    const rootRef = useRef<HTMLDivElement>(null);
    const inputBoxRef = useRef<HTMLDivElement>(null);
    const [pinnedHeaderHost, setPinnedHeaderHost] =
      useState<HTMLDivElement | null>(null);
    const handlePinnedHeaderHostRef = useCallback(
      (node: HTMLDivElement | null) => {
        setPinnedHeaderHost(node);
      },
      []
    );

    const isCursorIde = isCursorIdeSession(sessionId);
    const isExternalHistory = isExternalHistorySession(sessionId);
    const isImportedHistory = isImportedHistorySession(sessionId);
    const isReadOnlySurface = readOnly || isImportedHistory;

    useChatViewSessionLifecycle({
      sessionId,
      readOnly,
      secondary,
      isReadOnlySurface,
      isCursorIde,
    });

    const currentSession = useAtomValue(sessionByIdAtom(sessionId));
    const [orgtrackSummary, setOrgtrackSummary] =
      useState<CoreSessionSummary | null>(null);

    useEffect(() => {
      let cancelled = false;
      void getOrgtrackSessionSummary(sessionId)
        .then((summary) => {
          if (!cancelled) setOrgtrackSummary(summary);
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            logger.warn("failed to load orgtrack session summary", error);
            setOrgtrackSummary(null);
          }
        });
      return () => {
        cancelled = true;
      };
    }, [sessionId]);

    const initialFileChanges = useMemo(
      () =>
        resolveInitialFileChanges({
          currentSession,
          isCursorIde,
          isExternalHistory,
          orgtrackSummary,
        }),
      [currentSession, isCursorIde, isExternalHistory, orgtrackSummary]
    );

    // Every imported third-party history is immutable at its source. The
    // composer below is still interactive, but submitting it creates an
    // ORGII-owned continuation after the shared workspace/account/model
    // picker — it never writes back into Codex/Claude/Cursor/etc.

    const showInteractArea = useShowInteractArea();
    const showExternalHistoryForkComposer = isImportedHistory && !readOnly;
    const handleExternalHistoryForkSubmit = useCallback(
      async (input: SubmitOverrideInput) => {
        if (!isImportedHistory) return false;
        try {
          const newSessionId = await forkExternalHistoryIntoOrgiiSession({
            sourceSessionId: sessionId,
            sourceSession: currentSession,
            userMessage: input.agentContent ?? input.displayText,
            imageDataUrls: input.imageDataUrls,
          });
          await loadSessions({ forceRefresh: true });
          const continuationSession = store.get(sessionByIdAtom(newSessionId));
          const continuation = {
            sessionId: newSessionId,
            sessionName: continuationSession?.name,
            repoPath: continuationSession?.repoPath,
          };
          if (onSessionContinuation) {
            onSessionContinuation(continuation);
          } else {
            openSession(
              continuation.sessionId,
              continuation.sessionName,
              continuation.repoPath
            );
          }
        } catch (error) {
          // InputArea clears a handled override. Restore the exact draft on
          // cancel/failure so choosing credentials is never destructive.
          store.set(restoreToInputAtom, {
            sessionId,
            displayContent: input.displayText,
            imageDataUrls: input.imageDataUrls,
          });
          if (!(error instanceof ForkCancelledError)) {
            logger.error("failed to continue imported history", error);
            Message.error(tNavigation("collaboration.forkImported.error"));
          }
        }
        return true;
      },
      [
        currentSession,
        isImportedHistory,
        onSessionContinuation,
        openSession,
        sessionId,
        store,
        tNavigation,
      ]
    );
    const showFloatingComposer =
      (showInteractArea && !isReadOnlySurface) ||
      showExternalHistoryForkComposer;
    const [floatingComposerNode, setFloatingComposerNode] =
      useState<HTMLDivElement | null>(null);
    const [floatingComposerHeight, setFloatingComposerHeight] = useState(
      CHAT_FLOATING_COMPOSER_FALLBACK_INSET_PX
    );
    const setMeasuredFloatingComposerRef = useCallback(
      (node: HTMLDivElement | null) => {
        setFloatingComposerNode(node);
      },
      []
    );

    useEffect(() => {
      if (!showFloatingComposer || !floatingComposerNode) return;

      const updateHeight = () => {
        const nextHeight = Math.ceil(
          floatingComposerNode.getBoundingClientRect().height
        );
        setFloatingComposerHeight(
          nextHeight > 0 ? nextHeight : CHAT_FLOATING_COMPOSER_FALLBACK_INSET_PX
        );
      };

      updateHeight();
      const observer = new ResizeObserver(updateHeight);
      observer.observe(floatingComposerNode);
      window.addEventListener("resize", updateHeight);
      return () => {
        observer.disconnect();
        window.removeEventListener("resize", updateHeight);
      };
    }, [floatingComposerNode, showFloatingComposer]);

    const historyBottomInset = showFloatingComposer
      ? Math.max(
          CHAT_FLOATING_COMPOSER_FALLBACK_INSET_PX,
          floatingComposerHeight
        )
      : 0;
    const {
      showFollowAgent,
      followAgentLabel,
      followAgentTooltipLabel,
      followAgentShortcut,
      handleFollowAgent,
    } = useFollowAgent();
    const followAgentNav = useMemo(
      () => ({
        showFollowAgent,
        followAgentLabel,
        followAgentTooltipLabel,
        followAgentShortcut,
        onFollowAgent: handleFollowAgent,
      }),
      [
        showFollowAgent,
        followAgentLabel,
        followAgentTooltipLabel,
        followAgentShortcut,
        handleFollowAgent,
      ]
    );
    const browserAddToConversationNav = useBrowserAddToConversationAction();
    const stationMode = useAtomValue(stationModeAtom);
    const chatPanelMaximized = useAtomValue(chatPanelMaximizedAtom);
    const agentMessageClampEligible =
      stationMode === STATION_MODE.AGENT_STATION && !chatPanelMaximized;

    const streamRetryStatus = useAtomValue(streamRetryStatusAtom);
    const streamRetry =
      streamRetryStatus?.sessionId === sessionId ? streamRetryStatus : null;
    const snapshot = useAtomValue(derivedSnapshotAtom);
    const { snapshot: canvasForTurn } = useCanvasForTurn(sessionId);
    const latestCanvasPreview = snapshot?.latestCanvasPreview ?? null;
    const latestCanvasPayload = useMemo(
      () =>
        canvasForTurn.latestPayload
          ? canvasForTurn.latestPayload
          : latestCanvasPreview
            ? {
                mode: latestCanvasPreview.mode,
                url: latestCanvasPreview.url,
                title: latestCanvasPreview.title,
                streaming: latestCanvasPreview.streaming,
                eventId: latestCanvasPreview.eventId,
              }
            : null,
      [canvasForTurn.latestPayload, latestCanvasPreview]
    );
    const openLatestCanvas = useJumpToSimulatorCanvas(
      sessionId,
      latestCanvasPayload
    );
    const canvasPreviewPill = useMemo(
      () =>
        latestCanvasPayload &&
        canvasForTurn.allowsLatestCanvasShortcut &&
        openLatestCanvas
          ? {
              label: "Canvas",
              onOpen: openLatestCanvas,
            }
          : null,
      [
        canvasForTurn.allowsLatestCanvasShortcut,
        latestCanvasPayload,
        openLatestCanvas,
      ]
    );
    const currentPlanApproval = useAtomValue(pendingPlanApprovalsAtom).get(
      sessionId
    )?.current;
    const chatEvents = snapshot?.chatEvents ?? EMPTY_CHAT_EVENTS;
    const isAgentWorking = useAtomValue(isSessionActiveAtom);

    const gitArtifactStats = useMemo(
      () => ({
        commitCount: orgtrackSummary?.relatedCommits ?? 0,
        pullRequestCount: 0,
      }),
      [orgtrackSummary?.relatedCommits]
    );
    const planViewState = useMemo(
      () =>
        derivePlanApprovalViewState({
          pendingPlan: currentPlanApproval,
          chatEvents,
          displayEvents: chatEvents,
        }),
      [chatEvents, currentPlanApproval]
    );
    const showCurrentPlanSurface = planViewState.currentSurfaceVisible;
    const currentPlanSurfaceState = planViewState.activePendingEvent
      ? planViewState.getEventState(planViewState.activePendingEvent, "current")
      : undefined;

    const [scrollNav, setScrollNav] = useState<ScrollNavState | null>(null);
    const handleScrollNavChange = useCallback((state: ScrollNavState) => {
      setScrollNav(state);
    }, []);
    const externalScrollToBottomButton = scrollNav?.showScrollToBottom ? (
      <Button
        variant="secondary"
        appearance="outline"
        size="small"
        shape="round"
        icon={<ArrowDown size={14} />}
        iconOnly
        aria-label={t("common:chat.scrollToBottom")}
        title={t("common:chat.scrollToBottom")}
        onClick={scrollNav.onScrollToBottom}
        className="shrink-0"
      />
    ) : null;

    const {
      view: agentOrgRunView,
      error: agentOrgRunViewError,
      refresh: refreshAgentOrgRunView,
    } = useAgentOrgRunView(sessionId);
    // The dropdown's "current member" highlight should follow the
    // pipeline session, not the backend's `currentMemberId`. The
    // member selector now flips only the pipeline atom (via
    // `useAgentOrgMemberSessionJump`) so the parent ChatView keeps
    // rendering the org session — meaning the run view is fetched
    // against the parent and its `currentMemberId` would stick to
    // coordinator no matter which member the user picks. Match the
    // pipeline session against `sessionRuntime.sessionId` first; fall
    // back to the backend hint when no member matches (e.g. before
    // members hydrate or for the bare coordinator session).
    const pipelineSessionId = useAtomValue(activeSessionIdAtom);
    const currentAgentOrgMember = useMemo(() => {
      if (!agentOrgRunView) return null;
      const members = agentOrgRunView.members;
      if (pipelineSessionId) {
        const byPipeline = members.find(
          (member) => member.sessionRuntime?.sessionId === pipelineSessionId
        );
        if (byPipeline) return byPipeline;
      }
      if (!agentOrgRunView.currentMemberId) return null;
      return (
        members.find(
          (member) => member.memberId === agentOrgRunView.currentMemberId
        ) ?? null
      );
    }, [agentOrgRunView, pipelineSessionId]);
    const {
      agentOrgInteractionSessionId,
      queueSessionId,
      groupChatViewActive,
      groupChatViewAvailable,
      groupChatMergedEvents,
      groupChatAgents,
      handleGroupChatTapEvents,
      groupChatMentionOptions,
      groupChatRunPaused,
      groupChatPendingMessage,
      groupChatHistoryHasMore,
      groupChatHistoryLoading,
      groupChatHistoryError,
      loadOlderGroupChatHistory,
      retryGroupChatHistory,
      isResumingGroupChat,
      handleResumeGroupChatRun,
      handleGroupChatViewToggle,
      handleGroupChatSubmitOverride,
    } = useAgentOrgGroupChatController({
      sessionId,
      agentOrgRunView,
      currentAgentOrgMember,
      refreshAgentOrgRunView,
    });

    const handleAgentOrgMemberSessionJump =
      useAgentOrgMemberSessionJump(sessionId);

    const handleMainComposerSubmitOverride = useImportedSessionSubmitOverride({
      sessionId,
      currentSession,
      onFallbackSubmit: handleGroupChatSubmitOverride,
      onSessionContinuation,
    });

    const {
      cancelQueuedMessage,
      enqueueCount,
      handleReorderSessionQueue,
      handleSendNow,
      queueEditProps,
      sessionMessageQueue,
    } = useChatViewMessageQueue({
      pipelineSessionId,
      queueSessionId,
    });

    const groupChatPausedBottomContent = groupChatRunPaused ? (
      <GroupChatPausedBanner
        disabled={isResumingGroupChat}
        onResume={handleResumeGroupChatRun}
      />
    ) : null;

    const {
      intervention: agentOrgIntervention,
      error: agentOrgInterventionError,
      returning: agentOrgInterventionReturning,
      returnToWork: returnAgentOrgMemberToWork,
    } = useAgentOrgIntervention(
      agentOrgInteractionSessionId,
      agentOrgRunView,
      refreshAgentOrgRunView
    );
    const isViewingAgentOrgMemberPlan =
      currentAgentOrgMember !== null && !currentAgentOrgMember.isCoordinator;
    const shouldShowCurrentPlanSurface =
      showCurrentPlanSurface && !isViewingAgentOrgMemberPlan;

    // Primary card active-data state (reported up by each card)
    const [hasQuestion, setHasQuestion] = useState(false);
    const [hasPermission, setHasPermission] = useState(false);
    const [hasModeSwitch, setHasModeSwitch] = useState(false);
    const hasPlan = Boolean(
      currentPlanApproval && shouldShowCurrentPlanSurface
    );
    const [planPillNowMs, setPlanPillNowMs] = useState(() => Date.now());
    const currentPlanAutoApproveAt = currentPlanApproval?.autoApproveAt ?? null;
    useEffect(() => {
      if (!hasPlan || !currentPlanAutoApproveAt) return;
      const timer = window.setInterval(
        () => setPlanPillNowMs(Date.now()),
        1000
      );
      return () => window.clearInterval(timer);
    }, [currentPlanAutoApproveAt, hasPlan]);
    const planPillLabel = useMemo(
      () =>
        formatPlanPillLabel(
          hasPlan ? currentPlanAutoApproveAt : null,
          planPillNowMs
        ),
      [currentPlanAutoApproveAt, hasPlan, planPillNowMs]
    );
    const setStationMode = useSetAtom(stationModeAtom);
    const setSelectedSimulatorApp = useSetAtom(simulatorSelectedAppAtom);
    const setReplayMode = useSetAtom(replayModeAtom);
    const setChatPanelMaximized = useSetAtom(chatPanelMaximizedAtom);
    const setDiffScope = useSetAtom(simulatorDiffScopeRequestAtom);
    const refreshDiff = useSetAtom(bumpSimulatorDiffRefreshNonceAtom);
    const openAgentStationDiff = useCallback(() => {
      // Un-maximize the chat panel so ActivitySimulator becomes visible.
      // When chatPanelMaximized is true, AppShellContent suppresses the
      // simulator pane entirely (chatPanelFocused guard), so switching to
      // the Diff app would have no visible effect.
      //
      // Clear any per-round scope set by a chat `TurnMetadataFooter` so this
      // composer-level entry point always shows the whole-session diff.
      setDiffScope(null);
      // Force a fresh read of the canonical diffs so the full-session view
      // reflects edits made since the Diff app last cached them.
      refreshDiff();
      setChatPanelMaximized(false);
      setStationMode(STATION_MODE.AGENT_STATION);
      setSelectedSimulatorApp(AppType.DIFF);
      setReplayMode("replay");
    }, [
      setDiffScope,
      refreshDiff,
      setChatPanelMaximized,
      setReplayMode,
      setSelectedSimulatorApp,
      setStationMode,
    ]);

    const {
      onCommit,
      onCommitPush,
      onPush,
      onCreatePr,
      onViewMyStation,
      onViewAgentStation,
      hasCommitsToPush,
      gitActionsDisabled,
    } = useGitDiffActions({ sessionId, openAgentStationDiff });

    const filesMenu = useMemo(
      () => (
        <GitDiffActionsMenu
          onCommit={onCommit}
          onCommitPush={onCommitPush}
          onPush={onPush}
          onCreatePr={onCreatePr}
          onViewMyStation={onViewMyStation}
          onViewAgentStation={onViewAgentStation}
          hasCommitsToPush={hasCommitsToPush}
          gitActionsDisabled={gitActionsDisabled}
        />
      ),
      [
        onCommit,
        onCommitPush,
        onPush,
        onCreatePr,
        onViewMyStation,
        onViewAgentStation,
        hasCommitsToPush,
        gitActionsDisabled,
      ]
    );

    const {
      questionCollapsed,
      permissionCollapsed,
      modeSwitchCollapsed,
      planCollapsed,
      collapseQuestion,
      collapsePermission,
      collapseModeSwitch,
      collapsePlan,
      queueExpanded,
      processExpanded,
      toggleQueue,
      toggleProcess,
      hasAny,
      inlineSections,
      setProcessVisibleCount,
    } = useComposerSections({
      sessionId,
      queueCount: sessionMessageQueue.length,
      enqueueCount,
      hasQuestion,
      hasPermission,
      hasModeSwitch,
      hasPlan,
      planPillLabel,
      gitArtifactStats,
      onFilesExpand: openAgentStationDiff,
      filesMenu,
      includeFileSections: false,
    });

    const hasAgentOrgIntervention =
      agentOrgInterventionError !== null || agentOrgIntervention !== null;

    // ChatSessionContext provides the *content* session id — pipeline,
    // chat history, pinned bars, reload, etc. all key off this value.
    // When the user picks an Agent-Org member via the chip / pagination
    // pills, the pipeline atom flips to that member's session but the
    // ChatPanel's `sessionId` prop (= WorkStation memory) stays anchored
    // to the parent so the header/sidebar don't move. Without using the
    // member id here, ChatHistory would keep rendering the parent's
    // events even though the streaming pipeline has already moved on.
    // Group chat is the exception: the rendered history is the merged
    // coordinator-scoped feed, and header actions such as collapse-all are
    // keyed by the coordinator session id.
    const chatHistorySessionId = groupChatViewActive
      ? sessionId
      : agentOrgInteractionSessionId;
    // The visible ChatView's session is the authoritative composer target.
    // Agent-org member views may override it with queueSessionId, but ordinary
    // imported teammate sessions have no agent-org queue target. Passing null
    // there made useMessageDispatch fail before onSubmitOverride could run
    // ("no active sessionId"), bypassing the fork-before-send flow entirely.
    const inputAreaSessionId = queueSessionId ?? sessionId;
    const groupChatHistoryAction = groupChatViewActive ? (
      groupChatHistoryError ? (
        <Button
          variant="tertiary"
          appearance="ghost"
          size="small"
          onClick={retryGroupChatHistory}
          title={`${t("sessions:groupChat.historyLoadFailed", {
            defaultValue: "History unavailable",
          })}: ${groupChatHistoryError}`}
        >
          {t("common:retry", {
            defaultValue: "Retry",
          })}
        </Button>
      ) : groupChatHistoryHasMore ? (
        <Button
          variant="tertiary"
          appearance="ghost"
          size="small"
          loading={groupChatHistoryLoading}
          onClick={() => void loadOlderGroupChatHistory()}
          title={t("sessions:groupChat.loadOlder", {
            defaultValue: "Load older messages",
          })}
        >
          {t("sessions:groupChat.loadOlder", {
            defaultValue: "Load older messages",
          })}
        </Button>
      ) : null
    ) : null;

    // Idle-reload signal for the composer "N Files Changed" pill. The pill's
    // count comes from the per-session-cached orgtrack final diffs, so it must
    // refetch when the session changes, a new round appears, or the agent goes
    // idle — mirroring the per-round footer's `turnFilesReloadKey`. Counting
    // user-message boundaries (not raw event length) keeps this stable during
    // streaming so the backend isn't hammered mid-turn.
    const composerFilesReloadKey = buildCompactFilesReloadKey(
      inputAreaSessionId,
      countChatRounds(chatEvents),
      isAgentWorking
    );

    return (
      <ChatSessionContext.Provider value={chatHistorySessionId}>
        <div
          ref={rootRef}
          data-chat-view-root
          data-session-id={chatHistorySessionId}
          className="relative flex h-full min-w-0 max-w-full flex-col overflow-hidden"
        >
          <div
            ref={handlePinnedHeaderHostRef}
            className={
              turnPaginationEnabled || groupChatViewActive
                ? "flex flex-shrink-0 flex-col"
                : "absolute inset-x-0 top-0 z-40 flex flex-col"
            }
            data-chat-pinned-header-portal-host
          />
          <div className="min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
            <ChatViewHistorySurface
              sessionId={sessionId}
              currentSession={currentSession}
              snapshotHydrated={Boolean(snapshot)}
              chatEvents={chatEvents}
              groupChatViewActive={groupChatViewActive}
              groupChatMergedEvents={groupChatMergedEvents}
              groupChatAgents={groupChatAgents}
              pipelineSessionId={pipelineSessionId}
              handleGroupChatTapEvents={handleGroupChatTapEvents}
              agentMessageClampEligible={agentMessageClampEligible}
              surfaceBgClass={surfaceBgClass}
              position={position}
              currentAgentOrgMember={currentAgentOrgMember}
              agentOrgRunView={agentOrgRunView}
              agentOrgRunViewError={agentOrgRunViewError}
              refreshAgentOrgRunView={refreshAgentOrgRunView}
              handleAgentOrgMemberSessionJump={handleAgentOrgMemberSessionJump}
              handleScrollNavChange={handleScrollNavChange}
              followAgentNav={followAgentNav}
              browserAddToConversationNav={browserAddToConversationNav}
              onRegisterSearchOpen={onRegisterSearchOpen}
              displayMode={displayMode}
              turnPaginationEnabled={turnPaginationEnabled}
              paginationTrailingSlot={groupChatHistoryAction}
              pinnedHeaderHost={pinnedHeaderHost}
              historyBottomInset={historyBottomInset}
              groupChatViewAvailable={groupChatViewAvailable}
              handleGroupChatViewToggle={handleGroupChatViewToggle}
              isReadOnlySurface={isReadOnlySurface}
            />
          </div>
          {showExternalHistoryForkComposer && (
            <div
              ref={setMeasuredFloatingComposerRef}
              data-testid="external-history-fork-composer"
              className="absolute bottom-0 left-0 right-0 z-50 flex w-full flex-shrink-0 flex-col items-center px-2 pb-2 pt-1"
            >
              <div className="pointer-events-none absolute inset-x-0 bottom-0 top-[-28px] bg-gradient-to-t from-chat-pane via-chat-pane/90 to-transparent" />
              <div
                className={`${DETAIL_PANEL_TOKENS.contentMaxWidth} relative z-10 w-full`}
              >
                <ChatSessionContext.Provider value={CHAT_SESSION_CONTEXT_NONE}>
                  <InputArea
                    omitChatHeader
                    placeholder={tNavigation(
                      "collaboration.forkImported.continuePlaceholder"
                    )}
                    chatPanelPosition={position}
                    sessionScope="none"
                    onSubmitOverride={handleExternalHistoryForkSubmit}
                    topRowTrailingContent={externalScrollToBottomButton}
                    bottomAnchored
                  />
                </ChatSessionContext.Provider>
              </div>
            </div>
          )}
          {isImportedHistory &&
            !showExternalHistoryForkComposer &&
            externalScrollToBottomButton && (
              <div className="pointer-events-none absolute bottom-2 left-0 right-0 z-50">
                <div
                  className={`mx-auto flex w-full justify-end px-2 ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
                >
                  <span className="pointer-events-auto">
                    {externalScrollToBottomButton}
                  </span>
                </div>
              </div>
            )}
          {showInteractArea && !isReadOnlySurface && (
            <ChatFloatingComposer
              composerRef={setMeasuredFloatingComposerRef}
              inputBoxRef={inputBoxRef}
              chatPanelPosition={position}
              sessionId={sessionId}
              inputAreaSessionId={inputAreaSessionId}
              currentPlanApproval={currentPlanApproval}
              shouldShowCurrentPlanSurface={shouldShowCurrentPlanSurface}
              currentPlanSurfaceState={currentPlanSurfaceState}
              planCollapsed={planCollapsed}
              onPlanCollapse={collapsePlan}
              questionCollapsed={questionCollapsed}
              permissionCollapsed={permissionCollapsed}
              modeSwitchCollapsed={modeSwitchCollapsed}
              onQuestionCollapse={collapseQuestion}
              onPermissionCollapse={collapsePermission}
              onModeSwitchCollapse={collapseModeSwitch}
              onQuestionDataChange={setHasQuestion}
              onPermissionDataChange={setHasPermission}
              onModeSwitchDataChange={setHasModeSwitch}
              queueExpanded={queueExpanded}
              processExpanded={processExpanded}
              queuedMessages={sessionMessageQueue}
              onCancelQueuedMessage={cancelQueuedMessage}
              onSendQueuedMessageNow={handleSendNow}
              onReorderQueuedMessages={handleReorderSessionQueue}
              onToggleQueue={toggleQueue}
              onToggleProcess={toggleProcess}
              onProcessVisibleCountChange={setProcessVisibleCount}
              onFilesExpand={openAgentStationDiff}
              filesMenu={filesMenu}
              initialFileChanges={initialFileChanges}
              filesReloadKey={composerFilesReloadKey}
              groupChatPendingMessage={groupChatPendingMessage}
              groupChatViewActive={groupChatViewActive}
              hasAnyInlineSection={hasAny}
              scrollNav={scrollNav}
              canvasPreview={canvasPreviewPill}
              inlineSections={inlineSections}
              hasModeSwitch={hasModeSwitch}
              agentOrgIntervention={
                hasAgentOrgIntervention
                  ? {
                      intervention: agentOrgIntervention,
                      memberName: currentAgentOrgMember?.name,
                      error: agentOrgInterventionError,
                      returning: agentOrgInterventionReturning,
                      onReturnToWork: returnAgentOrgMemberToWork,
                    }
                  : null
              }
              streamRetry={streamRetry}
              groupChatPausedBottomContent={groupChatPausedBottomContent}
              onSubmitOverride={handleMainComposerSubmitOverride}
              customMentionOptions={groupChatMentionOptions}
              queueEditProps={queueEditProps}
              disableStopWhenEmpty={groupChatViewActive}
            />
          )}
        </div>
      </ChatSessionContext.Provider>
    );
  }
);

ChatView.displayName = "ChatView";

export default ChatView;
