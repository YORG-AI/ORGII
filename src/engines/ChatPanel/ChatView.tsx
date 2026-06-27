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
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type CoreSessionSummary,
  getOrgtrackSessionSummary,
} from "@src/api/tauri/lineage";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { useShowInteractArea } from "@src/contexts/workspace/ChatContext";
import { AgentMessageClampProvider } from "@src/engines/ChatPanel/blocks";
import { GroupChatPausedBanner } from "@src/engines/ChatPanel/components/ChatStatusBanners";
import { forkCodexAppHistoryIntoOrgiiSession } from "@src/engines/ChatPanel/externalHistoryFork";
import { useAgentOrgGroupChatController } from "@src/engines/ChatPanel/hooks/useAgentOrgGroupChatController";
import { AgentOrgGroupChatLiveSessions } from "@src/engines/ChatPanel/hooks/useAgentOrgGroupChatLiveSessions";
import { replayModeAtom } from "@src/engines/SessionCore";
import { chatEventsAtom } from "@src/engines/SessionCore/derived/chatEvents";
import { derivePlanApprovalViewState } from "@src/engines/SessionCore/derived/planDisplayEvents";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import { useFileReviewSync } from "@src/hooks/fileReview";
import { createLogger } from "@src/hooks/logger";
import { useSessionWorkspaceSync } from "@src/hooks/session/useSessionWorkspaceSync";
import {
  activeSessionIdAtom,
  loadSessions,
  sessionByIdAtom,
} from "@src/store/session";
import type { Session } from "@src/store/session";
import {
  isSessionActiveAtom,
  sessionRuntimeStatusAtom,
  streamRetryStatusAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { pendingPlanApprovalsAtom } from "@src/store/session/planApprovalAtom";
import type { ChatHistoryDisplayMode } from "@src/store/ui/chatPanelAtom";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import {
  dequeueMessageAtom,
  editMessageAtom,
  enqueueCountAtom,
  forceSendMessageAtom,
  messageQueueAtom,
  queueFlushRequestAtom,
  reorderQueueAtom,
} from "@src/store/ui/messageQueueAtom";
import {
  STATION_MODE,
  bumpSimulatorDiffRefreshNonceAtom,
  simulatorDiffScopeRequestAtom,
  simulatorSelectedAppAtom,
  stationModeAtom,
} from "@src/store/ui/simulatorAtom";
import { getFileName } from "@src/util/file/pathUtils";
import {
  isClaudeCodeHistorySession,
  isCodexAppSession,
  isCursorIdeSession,
  isExternalHistorySession,
} from "@src/util/session/sessionDispatch";

import ChatFloatingComposer from "./ChatFloatingComposer";
import ChatHistory, { type ScrollNavState } from "./ChatHistory";
import { GroupChatProvider } from "./ChatHistory/GroupChatView/GroupChatContext";
import { AgentEventsTap } from "./ChatHistory/GroupChatView/useGroupChatMergedEvents";
import { ChatHistoryOverrideContext } from "./ChatHistoryOverrideContext";
import {
  CHAT_SESSION_CONTEXT_NONE,
  ChatSessionContext,
} from "./ChatSessionContext";
import InputArea from "./InputArea";
import AgentOrgOverviewPanel from "./InputArea/components/AgentOrgOverviewPanel";
import type { FileChangesResult } from "./InputArea/components/CompactFileChanges";
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
import { useQueueEditMode } from "./InputArea/hooks/useQueueEditMode";
import { useBrowserAddToConversationAction } from "./hooks/useBrowserAddToConversationAction";
import { useFollowAgent } from "./hooks/useFollowAgent";

const logger = createLogger("ChatView");

const CHAT_FLOATING_COMPOSER_FALLBACK_INSET_PX = 72;

function impactFileChanges(input: {
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  touchedFiles?: readonly string[];
}): FileChangesResult | undefined {
  const touchedFiles = input.touchedFiles ?? [];
  const filesChanged = input.filesChanged ?? touchedFiles.length;
  const totalAdditions = input.linesAdded ?? 0;
  const totalDeletions = input.linesRemoved ?? 0;
  if (filesChanged === 0 && totalAdditions === 0 && totalDeletions === 0) {
    return undefined;
  }

  const displayPaths =
    touchedFiles.length > 0
      ? touchedFiles
      : Array.from(
          { length: filesChanged },
          (_unused, fileIndex) => `Changed file ${fileIndex + 1}`
        );
  const files = displayPaths.map((path, fileIndex) => ({
    path,
    fileName: getFileName(path),
    status: "M",
    additions: fileIndex === 0 ? totalAdditions : 0,
    deletions: fileIndex === 0 ? totalDeletions : 0,
    lineCount: fileIndex === 0 ? totalAdditions + totalDeletions : 0,
  }));

  return {
    files,
    totalAdditions,
    totalDeletions,
    stats: { added: 0, modified: filesChanged, deleted: 0 },
  };
}

function sourceImpactFileChanges(
  session: Session | undefined
): FileChangesResult | undefined {
  return impactFileChanges({
    filesChanged: session?.filesChanged,
    linesAdded: session?.linesAdded,
    linesRemoved: session?.linesRemoved,
    touchedFiles: session?.touchedFiles,
  });
}

function summaryImpactFileChanges(
  summary: CoreSessionSummary | null
): FileChangesResult | undefined {
  if (!summary) return undefined;
  return impactFileChanges({
    filesChanged: summary.filesChanged,
    linesAdded: summary.linesAdded,
    linesRemoved: summary.linesRemoved,
  });
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
  }) => {
    const setActiveSessionId = useSetAtom(activeSessionIdAtom);
    const store = useStore();
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

    useEffect(() => {
      if (readOnly) return;
      setActiveSessionId(sessionId);

      // Secondary surfaces (e.g. kanban detail panel) must release the
      // pipeline when the embedding closes, otherwise event streaming
      // would keep running for a session no surface is showing. We
      // only release if the pipeline is still pointing at this view's
      // session — another surface may already have taken over.
      // Primary (WorkStation) surfaces don't release on unmount: the
      // pipeline atom is owned by WorkStation memory, which the bridge
      // re-asserts whenever WorkStation is active.
      if (!secondary) return;
      return () => {
        const current = store.get(activeSessionIdAtom);
        if (current === sessionId) {
          setActiveSessionId(null);
        }
      };
    }, [sessionId, setActiveSessionId, readOnly, secondary, store]);

    useFileReviewSync(sessionId, !readOnly && !secondary);

    const isCursorIde = isCursorIdeSession(sessionId);
    const isExternalHistory = isExternalHistorySession(sessionId);
    const isReadOnlySurface = readOnly || isExternalHistory;
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
        isCursorIde || isExternalHistory
          ? (summaryImpactFileChanges(orgtrackSummary) ??
            sourceImpactFileChanges(currentSession))
          : undefined,
      [currentSession, isCursorIde, isExternalHistory, orgtrackSummary]
    );

    // Backend `agent_session_list_workspaces` only resolves sessions whose
    // runtime is currently attached. Historical sessions (status
    // `completed` / `failed` / `cancelled`) are persisted in `sessions.db`
    // but their runtime is dropped; the workspace state will be re-built
    // lazily by `init_session` on the next `agent_send_message`. Gate the
    // sync on a live status so opening a finished session in ChatView
    // doesn't fire a guaranteed `not found` snapshot pull.
    const runtimeStatus = useAtomValue(sessionRuntimeStatusAtom);
    const isLiveStatus =
      runtimeStatus === "running" || runtimeStatus === "installing";

    useSessionWorkspaceSync({
      sessionId,
      // Workspace sync only runs for live agent sessions on the *primary*
      // surface — never for read-only replay, secondary inspection,
      // imported Cursor IDE history rows, or historical sessions whose
      // runtime is not attached. Once the user sends a follow-up,
      // `agent_send_message` re-inits the runtime and flips the status
      // to "running", which lets sync resume.
      enabled: !isReadOnlySurface && !secondary && !isCursorIde && isLiveStatus,
    });

    // Cursor IDE sessions used to swap the composer for a read-only
    // banner; they're now writable through the regular `InputArea`
    // (the model pill swaps to a Cursor-aware variant inside that
    // component, and `cursorIdeAdapter.sendMessage` runs the probe
    // dispatch).

    const showInteractArea = useShowInteractArea();
    const showExternalHistoryForkComposer =
      isCodexAppSession(sessionId) || isClaudeCodeHistorySession(sessionId);
    const handleExternalHistoryForkSubmit = useCallback(
      async (input: { displayText: string; agentContent?: string }) => {
        if (!isCodexAppSession(sessionId)) return false;
        const newSessionId = await forkCodexAppHistoryIntoOrgiiSession({
          sourceSessionId: sessionId,
          sourceSession: currentSession,
          userMessage: input.agentContent ?? input.displayText,
        });
        await loadSessions({ forceRefresh: true });
        setActiveSessionId(newSessionId);
        return true;
      },
      [currentSession, sessionId, setActiveSessionId]
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
    const currentPlanApproval = useAtomValue(pendingPlanApprovalsAtom).get(
      sessionId
    )?.current;
    const chatEvents = useAtomValue(chatEventsAtom);
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

    // Message queue — keep this aligned with InputArea.sessionId so queued
    // follow-ups written by the composer are visible on the same surface.
    // Promoted "now" messages stay VISIBLE with a "sending now…" state: the
    // force-send interrupt window can last seconds (provider cancelled-
    // terminal latency), and hiding the message made Send Now look like it
    // silently swallowed the input.
    const messageQueue = useAtomValue(messageQueueAtom);
    const sessionMessageQueue = useMemo(
      () =>
        messageQueue.filter(
          (message) =>
            message.sessionId === queueSessionId ||
            message.sessionId === pipelineSessionId
        ),
      [messageQueue, pipelineSessionId, queueSessionId]
    );
    const enqueueCount = useAtomValue(enqueueCountAtom);
    const cancelQueuedMessage = useSetAtom(dequeueMessageAtom);
    const editQueuedMessage = useSetAtom(editMessageAtom);
    const reorderQueue = useSetAtom(reorderQueueAtom);
    const forceSendQueuedMessage = useSetAtom(forceSendMessageAtom);
    const setQueueFlushRequest = useSetAtom(queueFlushRequestAtom);

    const handleSendNow = useCallback(
      (messageId: string) => {
        const message = messageQueue.find((item) => item.id === messageId);
        if (!message) return;
        forceSendQueuedMessage(messageId);
        setQueueFlushRequest((requestId) => requestId + 1);
      },
      [messageQueue, forceSendQueuedMessage, setQueueFlushRequest]
    );

    const handleCommitQueueEdit = useCallback(
      (messageId: string, content: string, imageDataUrls?: string[]) => {
        editQueuedMessage({ messageId, content, imageDataUrls });
      },
      [editQueuedMessage]
    );

    const handleReorderSessionQueue = useCallback(
      (fromIndex: number, toIndex: number) => {
        const fromMessage = sessionMessageQueue[fromIndex];
        const toMessage = sessionMessageQueue[toIndex];
        if (!fromMessage || !toMessage) return;
        const globalFromIndex = messageQueue.findIndex(
          (message) => message.id === fromMessage.id
        );
        const globalToIndex = messageQueue.findIndex(
          (message) => message.id === toMessage.id
        );
        reorderQueue({ fromIndex: globalFromIndex, toIndex: globalToIndex });
      },
      [messageQueue, reorderQueue, sessionMessageQueue]
    );
    const queueEditProps = useQueueEditMode({
      onCommit: handleCommitQueueEdit,
      onCommitSendNow: handleSendNow,
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
    } = useAgentOrgIntervention(agentOrgInteractionSessionId);
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
      // Clear any per-round scope set by a chat `TurnFilesFooter` so this
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
    const inputAreaSessionId = queueSessionId;

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
            className="flex flex-shrink-0 flex-col"
            data-chat-pinned-header-portal-host
          />
          <div className="min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
            <ChatHistoryOverrideContext.Provider
              value={groupChatViewActive ? groupChatMergedEvents : undefined}
            >
              <GroupChatProvider
                enabled={groupChatViewActive}
                coordinatorSessionId={sessionId}
                orgMembers={agentOrgRunView?.members ?? []}
              >
                {groupChatViewActive && (
                  <AgentOrgGroupChatLiveSessions
                    enabled={groupChatViewActive}
                    excludeSessionId={pipelineSessionId}
                    members={agentOrgRunView?.members ?? []}
                  />
                )}
                {groupChatViewActive &&
                  groupChatAgents
                    .filter(
                      (agent) =>
                        !agent.sessionId.startsWith("agent-org-member-pending:")
                    )
                    .map((agent) => (
                      <AgentEventsTap
                        key={agent.sessionId}
                        sessionId={agent.sessionId}
                        onEvents={handleGroupChatTapEvents}
                      />
                    ))}
                <AgentMessageClampProvider value={agentMessageClampEligible}>
                  <ChatHistory
                    surfaceBgClass={surfaceBgClass}
                    agentOrgCurrentMemberName={
                      currentAgentOrgMember?.name ?? null
                    }
                    agentOrgCurrentMemberId={
                      currentAgentOrgMember?.memberId ?? null
                    }
                    agentOrgMembers={agentOrgRunView?.members ?? []}
                    mutationActionsDisabled={isReadOnlySurface}
                    agentOrgOverviewPanel={
                      agentOrgRunView || agentOrgRunViewError ? (
                        <AgentOrgOverviewPanel
                          view={agentOrgRunView}
                          error={agentOrgRunViewError}
                          currentSessionId={sessionId}
                          onRefresh={refreshAgentOrgRunView}
                        />
                      ) : null
                    }
                    onAgentOrgMemberSelect={handleAgentOrgMemberSessionJump}
                    onAgentOrgRunViewRefresh={refreshAgentOrgRunView}
                    onScrollNavChange={handleScrollNavChange}
                    followAgentNav={followAgentNav}
                    browserAddToConversationNav={browserAddToConversationNav}
                    onRegisterSearchOpen={onRegisterSearchOpen}
                    displayMode={displayMode}
                    turnPaginationEnabled={turnPaginationEnabled}
                    pinnedHeaderPortalHost={pinnedHeaderHost}
                    bottomInset={historyBottomInset}
                    groupChatViewAvailable={groupChatViewAvailable}
                    groupChatViewActive={groupChatViewActive}
                    onGroupChatViewToggle={handleGroupChatViewToggle}
                  />
                </AgentMessageClampProvider>
              </GroupChatProvider>
            </ChatHistoryOverrideContext.Provider>
          </div>
          {showExternalHistoryForkComposer && (
            <div
              ref={setMeasuredFloatingComposerRef}
              className="absolute bottom-0 left-0 right-0 z-50 flex w-full flex-shrink-0 flex-col items-center px-2 pb-2 pt-1"
            >
              <div className="pointer-events-none absolute inset-x-0 bottom-0 top-[-28px] bg-gradient-to-t from-chat-pane via-chat-pane/90 to-transparent" />
              <div
                className={`${DETAIL_PANEL_TOKENS.contentMaxWidth} relative z-10 w-full`}
              >
                <ChatSessionContext.Provider value={CHAT_SESSION_CONTEXT_NONE}>
                  <InputArea
                    omitChatHeader
                    chatPanelPosition={position}
                    sessionScope="none"
                    onSubmitOverride={handleExternalHistoryForkSubmit}
                    bottomAnchored
                  />
                </ChatSessionContext.Provider>
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
              onSubmitOverride={handleGroupChatSubmitOverride}
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
