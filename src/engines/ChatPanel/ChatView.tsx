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
import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useShowInteractArea } from "@src/contexts/workspace/ChatContext";
import { derivePlanApprovalViewState } from "@src/engines/SessionCore/derived/planDisplayEvents";
import { chatEventsForSessionAtomFamily } from "@src/engines/SessionCore/derived/sessionScopedChatEvents";
import { useTodoSync } from "@src/engines/SessionCore/hooks/session/useTodoSync";
import { useCloudSessionHasDownloadSurface } from "@src/features/Org2Cloud/useCloudSessionDownloadSurface";
import { useFileReviewSync } from "@src/hooks/fileReview";
import { usePendingPlanApproval } from "@src/hooks/session/usePendingPlanApproval";
import { useSessionWorkspaceSync } from "@src/hooks/session/useSessionWorkspaceSync";
import { loadSessions, sessionByIdAtom } from "@src/store/session";
import type { Session } from "@src/store/session";
import {
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
import { ConversationExecutionBindingContext } from "./ConversationExecutionBindingContext";
import { resolveConversationRunnerBindings } from "./ConversationStreamProvider";
import { useComposerSections } from "./InputArea/hooks/useComposerSections";
import {
  shouldShowExternalHistoryContinuationComposer,
  shouldShowMainChatComposer,
} from "./chatViewComposerVisibility";
import { resolveInitialFileChanges } from "./chatViewFileChanges";
import { useConversationSubmitRouter } from "./hooks/conversationSubmit/useConversationSubmitRouter";
import { useBrowserAddToConversationAction } from "./hooks/useBrowserAddToConversationAction";
import { useChatViewAgentOrgSurface } from "./hooks/useChatViewAgentOrgSurface";
import { useChatViewAgentStationDiff } from "./hooks/useChatViewAgentStationDiff";
import { useChatViewFilesMenu } from "./hooks/useChatViewFilesMenu";
import { useChatViewFloatingComposerInset } from "./hooks/useChatViewFloatingComposerInset";
import { useChatViewOrgtrackSummary } from "./hooks/useChatViewOrgtrackSummary";
import { useChatViewPipelineClaim } from "./hooks/useChatViewPipelineClaim";
import { useChatViewPlanPillState } from "./hooks/useChatViewPlanPillState";
import { useChatViewScrollToBottom } from "./hooks/useChatViewScrollToBottom";
import { useConversationTargetBinding } from "./hooks/useConversationTargetBinding";
import { useFollowAgent } from "./hooks/useFollowAgent";
import {
  latestCompletedAssistantFingerprint,
  useWorkItemFollowUpSuggestions,
} from "./hooks/useWorkItemFollowUpSuggestions";

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
  }) => {
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
    const conversationTargetBinding = useConversationTargetBinding(sessionId);
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

    const showInteractArea = useShowInteractArea();
    const hasCloudDownloadSurface =
      useCloudSessionHasDownloadSurface(sessionId);
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
    const followUpEventsAtom = useMemo(
      () =>
        selectAtom(
          chatEventsForSessionAtomFamily(sessionId),
          (events) => events,
          (previous, next) =>
            latestCompletedAssistantFingerprint(previous) ===
            latestCompletedAssistantFingerprint(next)
        ),
      [sessionId]
    );
    const followUpEvents = useAtomValue(followUpEventsAtom);
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
    const showExternalHistoryContinuationComposer =
      shouldShowExternalHistoryContinuationComposer({
        hasBlockingDownloadSurface,
        isImportedHistory,
        readOnly,
      });
    const showMainComposer =
      shouldShowMainChatComposer({
        showInteractArea,
        isReadOnlySurface,
        hasBlockingDownloadSurface,
      }) || showExternalHistoryContinuationComposer;
    const { setMeasuredFloatingComposerRef, historyBottomInset } =
      useChatViewFloatingComposerInset(showMainComposer);

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
      retryFailedGroupChatMessage,
      groupChatMentionOptions,
      groupChatPendingMessage,
      handleGroupChatViewToggle,
      handleAgentOrgMemberSessionJump,
      handleMainComposerSubmitOverride,
      cancelQueuedMessage,
      queueTailKey,
      handleClearSessionQueue,
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
      showCurrentPlanSurface,
      conversationRoot: conversationTargetBinding?.root ?? null,
    });
    const {
      submit: handleConversationSubmit,
      retry: handleCanonicalConversationRetry,
      resolveDispatch: resolveCanonicalRetryDispatch,
    } = useConversationSubmitRouter({
      sessionId,
      currentSession,
      root: conversationTargetBinding?.root ?? null,
      selectedTarget: conversationTargetBinding?.target ?? null,
      onSurfaceSubmit: handleMainComposerSubmitOverride,
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
      queueTailKey,
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
    // there made useMessageDispatch fail before onSubmitOverride could admit
    // the turn to the canonical queue ("no active sessionId"), so no writable
    // native execution episode could be prepared.
    const inputAreaSessionId = queueSessionId ?? sessionId;
    const {
      suggestions: followUpSuggestions,
      clearSuggestions: clearFollowUpSuggestions,
    } = useWorkItemFollowUpSuggestions({
      sessionId,
      inputAreaSessionId,
      session: currentSession,
      events: followUpEvents,
    });

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
        onClearQueuedMessages: handleClearSessionQueue,
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
        onSubmitOverride: handleConversationSubmit,
        customMentionOptions: groupChatMentionOptions,
        queueEditProps,
        disableStopWhenEmpty: groupChatViewActive,
        followUpSuggestions,
        onFollowUpSuggestionSent: clearFollowUpSuggestions,
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
        handleClearSessionQueue,
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
        handleConversationSubmit,
        groupChatMentionOptions,
        queueEditProps,
        followUpSuggestions,
        clearFollowUpSuggestions,
      ]
    );

    // External-history sessions (claudecodeapp/codexapp imports) never enter
    // sessionsAtom, but their org tags and push markers are keyed by bare
    // session id — a session_id-only stub keeps the discussion surface alive
    // on their local view. Scope-only shares still need the full row and
    // stay uncovered here. Imported replay rows are retained centrally by the
    // session loader, so this surface does not keep a second Session cache.
    const commentsSession =
      currentSession ??
      (isExternalHistorySession(sessionId)
        ? ({ session_id: sessionId } as Session)
        : null);
    const commentsTargetOverride =
      conversationTargetBinding?.cloudTarget ?? null;

    return (
      <ChatSessionContext.Provider value={chatHistorySessionId}>
        <ChatViewLiveRegion
          commentsSession={commentsSession}
          commentsTargetOverride={commentsTargetOverride}
          turnAnchorsVisible={!groupChatViewActive}
          rootRef={rootRef}
          dataSessionId={chatHistorySessionId}
          conversationSessionId={sessionId}
          conversationOverrideEvents={
            groupChatViewActive ? groupChatMergedEvents : undefined
          }
        >
          {(activeRunnerSessionId) => {
            const runnerBindings = resolveConversationRunnerBindings(
              sessionId,
              activeRunnerSessionId
            );
            return (
              <>
                <div
                  ref={handlePinnedHeaderHostRef}
                  className={
                    turnPaginationEnabled || groupChatViewActive
                      ? "flex shrink-0 flex-col"
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
                <div className="min-h-0 max-w-full min-w-0 flex-1 overflow-hidden">
                  <ChatViewHistorySurface
                    sessionId={runnerBindings.sourceSessionId}
                    groupChatViewActive={groupChatViewActive}
                    groupChatAgents={groupChatAgents}
                    pipelineSessionId={pipelineSessionId}
                    handleGroupChatTapEvents={handleGroupChatTapEvents}
                    retryFailedGroupChatMessage={retryFailedGroupChatMessage}
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
                    onFailedUserIntentRetry={handleCanonicalConversationRetry}
                    resolveFailedUserIntentDispatch={
                      resolveCanonicalRetryDispatch
                    }
                    planningIndicatorScope={
                      runnerBindings.planningIndicatorScope
                    }
                  />
                </div>
                <ChatViewPostHistoryOverlays
                  composerVisible={showMainComposer}
                  externalScrollToBottomButton={externalScrollToBottomButton}
                  isImportedHistory={isImportedHistory}
                />
                <ConversationExecutionBindingContext.Provider
                  value={conversationTargetBinding}
                >
                  <ChatViewComposerSection
                    {...composerSectionProps}
                    controlSessionId={runnerBindings.controlSessionId}
                  />
                </ConversationExecutionBindingContext.Provider>
              </>
            );
          }}
        </ChatViewLiveRegion>
      </ChatSessionContext.Provider>
    );
  }
);

ChatView.displayName = "ChatView";

export default ChatView;
