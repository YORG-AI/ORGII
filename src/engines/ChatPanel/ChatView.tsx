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
import { useAtomValue, useStore } from "jotai";
import { selectAtom } from "jotai/utils";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { getImportedHistoryCliResume } from "@src/api/tauri/externalHistory";
import Message from "@src/components/Message";
import { useShowInteractArea } from "@src/contexts/workspace/ChatContext";
import { forkExternalHistoryIntoOrgiiSession } from "@src/engines/ChatPanel/externalHistoryFork";
import { derivePlanApprovalViewState } from "@src/engines/SessionCore/derived/planDisplayEvents";
import { chatEventsForSessionAtomFamily } from "@src/engines/SessionCore/derived/sessionScopedChatEvents";
import { useTodoSync } from "@src/engines/SessionCore/hooks/session/useTodoSync";
import { usePinnedSession } from "@src/features/Org2Cloud/SessionConversation/usePinnedSession";
import { useCloudSessionHasDownloadSurface } from "@src/features/Org2Cloud/useCloudSessionDownloadSurface";
import { ForkCancelledError } from "@src/features/TeamCollaboration/forkSession";
import { useFileReviewSync } from "@src/hooks/fileReview";
import { createLogger } from "@src/hooks/logger";
import { usePendingPlanApproval } from "@src/hooks/session/usePendingPlanApproval";
import { useSessionWorkspaceSync } from "@src/hooks/session/useSessionWorkspaceSync";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { loadSessions, sessionByIdAtom } from "@src/store/session";
import type { Session } from "@src/store/session";
import {
  restoreToInputAtom,
  sessionRuntimeStatusAtom,
  streamRetryStatusAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { STATION_MODE, stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  isCursorIdeSession,
  isExternalHistorySession,
  isImportedHistorySession,
} from "@src/util/session/sessionDispatch";

import { ChatSessionContext } from "./ChatSessionContext";
import { ChatViewComposerSection } from "./ChatViewComposerSection";
import type { ChatViewComposerSectionProps } from "./ChatViewComposerSection.types";
import { ChatViewHistorySurface } from "./ChatViewHistorySurface";
import { ChatViewLiveRegion } from "./ChatViewLiveRegion";
import { ChatViewPostHistoryOverlays } from "./ChatViewPostHistoryOverlays";
import type { ChatViewProps } from "./ChatViewTypes";
import { useComposerSections } from "./InputArea/hooks/useComposerSections";
import {
  shouldShowExternalHistoryForkComposer,
  shouldShowMainChatComposer,
} from "./chatViewComposerVisibility";
import { resolveInitialFileChanges } from "./chatViewFileChanges";
import { useBrowserAddToConversationAction } from "./hooks/useBrowserAddToConversationAction";
import { useChatViewAgentOrgSurface } from "./hooks/useChatViewAgentOrgSurface";
import { useChatViewAgentStationDiff } from "./hooks/useChatViewAgentStationDiff";
import { useChatViewFilesMenu } from "./hooks/useChatViewFilesMenu";
import { useChatViewFloatingComposerInset } from "./hooks/useChatViewFloatingComposerInset";
import { useChatViewOrgtrackSummary } from "./hooks/useChatViewOrgtrackSummary";
import { useChatViewPipelineClaim } from "./hooks/useChatViewPipelineClaim";
import { useChatViewPlanPillState } from "./hooks/useChatViewPlanPillState";
import { useChatViewScrollToBottom } from "./hooks/useChatViewScrollToBottom";
import { useFollowAgent } from "./hooks/useFollowAgent";
import type { SubmitOverrideInput } from "./hooks/useInputArea/types";

const logger = createLogger("ChatView");

export type { ChatViewProps } from "./ChatViewTypes";

const ChatView: React.FC<ChatViewProps> = memo(
  ({
    sessionId,
    displayMode = "full",
    turnPaginationEnabled = true,
    position = "right",
    surfaceBgClass = "bg-chat-pane",
    readOnly = false,
    secondary = false,
    chromeTopInset = 0,
    onSessionContinuation,
  }) => {
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

    useChatViewPipelineClaim({ sessionId, readOnly, secondary });

    useTodoSync(isReadOnlySurface ? undefined : sessionId);
    useFileReviewSync(sessionId, !isReadOnlySurface && !secondary);
    const currentSession = useAtomValue(sessionByIdAtom(sessionId));
    const pinnedCommentsSession = usePinnedSession(sessionId) ?? null;
    const hydratedSessionIdsRef = useRef(new Set<string>());
    useEffect(() => {
      if (
        isImportedHistory ||
        currentSession?.productMode ||
        hydratedSessionIdsRef.current.has(sessionId)
      ) {
        return;
      }
      // Background Routine/dispatcher Sessions may be opened from their Work
      // Item before the sidebar has scanned the new row. Hydrate the complete
      // aggregate (including productMode) so Project is not rendered as a
      // misleading plain Build composer during that first visit.
      hydratedSessionIdsRef.current.add(sessionId);
      void loadSessions({ forceRefresh: true });
    }, [currentSession?.productMode, isImportedHistory, sessionId]);
    const orgtrackSummary = useChatViewOrgtrackSummary(sessionId);

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

    // Every imported third-party history is immutable at its source. The
    // composer below is still interactive, but submitting it creates an
    // ORGII-owned continuation after the shared workspace/account/model
    // picker — it never writes back into Codex/Claude/Cursor/etc.

    const showInteractArea = useShowInteractArea();
    const hasCloudDownloadSurface =
      useCloudSessionHasDownloadSurface(sessionId);
    // Sources whose CLI cannot reopen a session (Cursor IDE, Windsurf,
    // Trae, …) are pure read-only replays: no composer, no continuation
    // affordance. Only CLI-continuable histories offer the fork composer.
    const importedCliResume = getImportedHistoryCliResume(sessionId);
    const handleExternalHistoryForkSubmit = useCallback(
      async (input: SubmitOverrideInput) => {
        if (!isImportedHistory) return false;
        try {
          // Carry BOTH projection fields (mirrors
          // useImportedSessionSubmitOverride): displayText stays the user's
          // visible words, agentContent is the dispatched agent input. The
          // old `agentContent ?? displayText` collapse persisted the internal
          // contract as the user's message.
          const newSessionId = await forkExternalHistoryIntoOrgiiSession({
            sourceSessionId: sessionId,
            sourceSession: currentSession,
            userMessage: input.displayText,
            agentMessage: input.agentContent,
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
    const currentPlanApproval = usePendingPlanApproval(sessionId);
    const transcriptEmptyAtom = useMemo(
      () =>
        selectAtom(
          chatEventsForSessionAtomFamily(sessionId),
          (events) => events.length === 0,
          (left, right) => left === right
        ),
      [sessionId]
    );
    const transcriptEmpty = useAtomValue(transcriptEmptyAtom);
    const showCurrentPlanSurfaceAtom = useMemo(
      () =>
        selectAtom(
          chatEventsForSessionAtomFamily(sessionId),
          (chatEvents) =>
            derivePlanApprovalViewState({
              pendingPlan: currentPlanApproval,
              chatEvents,
              displayEvents: chatEvents,
            }).currentSurfaceVisible,
          (left, right) => left === right
        ),
      [sessionId, currentPlanApproval]
    );
    const showCurrentPlanSurface = useAtomValue(showCurrentPlanSurfaceAtom);
    const hasBlockingDownloadSurface =
      hasCloudDownloadSurface && transcriptEmpty;
    const showExternalHistoryForkComposer =
      shouldShowExternalHistoryForkComposer({
        hasBlockingDownloadSurface,
        isImportedHistory,
        readOnly,
        canResume: Boolean(importedCliResume),
      });
    const showMainComposer = shouldShowMainChatComposer({
      showInteractArea,
      isReadOnlySurface,
      hasBlockingDownloadSurface,
    });
    const showFloatingComposer =
      showMainComposer || showExternalHistoryForkComposer;
    const { setMeasuredFloatingComposerRef, historyBottomInset } =
      useChatViewFloatingComposerInset(showFloatingComposer);

    const gitArtifactStats = useMemo(
      () => ({
        commitCount: orgtrackSummary?.relatedCommits ?? 0,
        pullRequestCount: 0,
      }),
      [orgtrackSummary?.relatedCommits]
    );

    const { scrollNav, handleScrollNavChange, externalScrollToBottomButton } =
      useChatViewScrollToBottom();

    const {
      agentOrgRunView,
      agentOrgRunViewError,
      refreshAgentOrgRunView,
      pipelineSessionId,
      currentAgentOrgMember,
      agentOrgInteractionSessionId,
      queueSessionId,
      groupChatViewActive,
      groupChatViewAvailable,
      groupChatMergedEvents,
      groupChatAgents,
      handleGroupChatTapEvents,
      groupChatMentionOptions,
      groupChatPendingMessage,
      handleGroupChatViewToggle,
      handleAgentOrgMemberSessionJump,
      handleMainComposerSubmitOverride,
      cancelQueuedMessage,
      enqueueCount,
      handleReorderSessionQueue,
      handleSendNow,
      queueEditProps,
      sessionMessageQueue,
      groupChatPausedBottomContent,
      shouldShowCurrentPlanSurface,
      agentOrgInterventionSlot,
      groupChatHistoryAction,
    } = useChatViewAgentOrgSurface({
      sessionId,
      currentSession,
      onSessionContinuation,
      showCurrentPlanSurface,
    });

    // Primary card active-data state (reported up by each card)
    const [hasQuestion, setHasQuestion] = useState(false);
    const [hasPermission, setHasPermission] = useState(false);
    const [hasModeSwitch, setHasModeSwitch] = useState(false);
    const { hasPlan, planPillLabel } = useChatViewPlanPillState({
      currentPlanApproval,
      shouldShowCurrentPlanSurface,
    });
    const openAgentStationDiff = useChatViewAgentStationDiff();

    const { filesMenu } = useChatViewFilesMenu({
      sessionId,
      openAgentStationDiff,
    });

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

    const composerSectionProps = useMemo(
      (): ChatViewComposerSectionProps => ({
        sessionId,
        inputAreaSessionId,
        showMainComposer,
        composerRef: setMeasuredFloatingComposerRef,
        inputBoxRef,
        chatPanelPosition: position,
        planCollapsed,
        onPlanCollapse: collapsePlan,
        questionCollapsed,
        permissionCollapsed,
        modeSwitchCollapsed,
        onQuestionCollapse: collapseQuestion,
        onPermissionCollapse: collapsePermission,
        onModeSwitchCollapse: collapseModeSwitch,
        onQuestionDataChange: setHasQuestion,
        onPermissionDataChange: setHasPermission,
        onModeSwitchDataChange: setHasModeSwitch,
        queueExpanded,
        processExpanded,
        queuedMessages: sessionMessageQueue,
        onCancelQueuedMessage: cancelQueuedMessage,
        onSendQueuedMessageNow: handleSendNow,
        onReorderQueuedMessages: handleReorderSessionQueue,
        onToggleQueue: toggleQueue,
        onToggleProcess: toggleProcess,
        onProcessVisibleCountChange: setProcessVisibleCount,
        onFilesExpand: openAgentStationDiff,
        filesMenu,
        initialFileChanges,
        groupChatPendingMessage,
        groupChatViewActive,
        hasAnyInlineSection: hasAny,
        scrollNav,
        inlineSections,
        hasModeSwitch,
        agentOrgIntervention: agentOrgInterventionSlot,
        streamRetry,
        groupChatPausedBottomContent,
        onSubmitOverride: handleMainComposerSubmitOverride,
        customMentionOptions: groupChatMentionOptions,
        queueEditProps,
        disableStopWhenEmpty: groupChatViewActive,
      }),
      [
        sessionId,
        inputAreaSessionId,
        showMainComposer,
        setMeasuredFloatingComposerRef,
        position,
        planCollapsed,
        collapsePlan,
        questionCollapsed,
        permissionCollapsed,
        modeSwitchCollapsed,
        collapseQuestion,
        collapsePermission,
        collapseModeSwitch,
        queueExpanded,
        processExpanded,
        sessionMessageQueue,
        cancelQueuedMessage,
        handleSendNow,
        handleReorderSessionQueue,
        toggleQueue,
        toggleProcess,
        setProcessVisibleCount,
        openAgentStationDiff,
        filesMenu,
        initialFileChanges,
        groupChatPendingMessage,
        groupChatViewActive,
        hasAny,
        scrollNav,
        inlineSections,
        hasModeSwitch,
        agentOrgInterventionSlot,
        streamRetry,
        groupChatPausedBottomContent,
        handleMainComposerSubmitOverride,
        groupChatMentionOptions,
        queueEditProps,
      ]
    );

    // External-history sessions (claudecodeapp/codexapp imports) never enter
    // sessionsAtom, but their org tags and push markers are keyed by bare
    // session id — a session_id-only stub keeps the discussion surface alive
    // on their local view. Scope-only shares still need the full row and
    // stay uncovered here. Rows that WERE resident stay pinned so a sidebar
    // roster refresh cannot strip the open conversation's identity fields.
    const commentsSession =
      pinnedCommentsSession ??
      (isExternalHistorySession(sessionId)
        ? ({ session_id: sessionId } as Session)
        : null);

    return (
      <ChatSessionContext.Provider value={chatHistorySessionId}>
        <ChatViewLiveRegion
          commentsSession={commentsSession}
          turnAnchorsVisible={!groupChatViewActive}
          rootRef={rootRef}
          dataSessionId={chatHistorySessionId}
          transcript={
            <>
              <div
                ref={handlePinnedHeaderHostRef}
                className={
                  turnPaginationEnabled || groupChatViewActive
                    ? "flex flex-shrink-0 flex-col"
                    : "absolute inset-x-0 top-0 z-40 flex flex-col"
                }
                style={
                  chromeTopInset > 0
                    ? turnPaginationEnabled || groupChatViewActive
                      ? { paddingTop: chromeTopInset }
                      : { top: chromeTopInset }
                    : undefined
                }
                data-chat-pinned-header-portal-host
              />
              <div className="min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
                <ChatViewHistorySurface
                  sessionId={sessionId}
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
                  handleAgentOrgMemberSessionJump={
                    handleAgentOrgMemberSessionJump
                  }
                  handleScrollNavChange={handleScrollNavChange}
                  followAgentNav={followAgentNav}
                  browserAddToConversationNav={browserAddToConversationNav}
                  displayMode={displayMode}
                  turnPaginationEnabled={turnPaginationEnabled}
                  paginationTrailingSlot={groupChatHistoryAction}
                  pinnedHeaderHost={pinnedHeaderHost}
                  chromeTopInset={chromeTopInset}
                  historyBottomInset={historyBottomInset}
                  groupChatViewAvailable={groupChatViewAvailable}
                  handleGroupChatViewToggle={handleGroupChatViewToggle}
                  isReadOnlySurface={isReadOnlySurface}
                />
              </div>
              <ChatViewPostHistoryOverlays
                showExternalHistoryForkComposer={
                  showExternalHistoryForkComposer
                }
                composerRef={setMeasuredFloatingComposerRef}
                position={position}
                onSubmitOverride={handleExternalHistoryForkSubmit}
                externalScrollToBottomButton={externalScrollToBottomButton}
                isImportedHistory={isImportedHistory}
                sessionId={sessionId}
              />
            </>
          }
          composer={<ChatViewComposerSection {...composerSectionProps} />}
        />
      </ChatSessionContext.Provider>
    );
  }
);

ChatView.displayName = "ChatView";

export default ChatView;
