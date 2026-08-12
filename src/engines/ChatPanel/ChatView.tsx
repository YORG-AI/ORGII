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
import { derivedSnapshotAtom } from "@src/engines/SessionCore/core/atoms/events";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { derivePlanApprovalViewState } from "@src/engines/SessionCore/derived/planDisplayEvents";
import { useTodoSync } from "@src/engines/SessionCore/hooks/session/useTodoSync";
import { ForkCancelledError } from "@src/features/TeamCollaboration/forkSession";
import { useFileReviewSync } from "@src/hooks/fileReview";
import { createLogger } from "@src/hooks/logger";
import { usePendingPlanApproval } from "@src/hooks/session/usePendingPlanApproval";
import { useSessionWorkspaceSync } from "@src/hooks/session/useSessionWorkspaceSync";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { loadSessions, sessionByIdAtom } from "@src/store/session";
import {
  isSessionActiveAtom,
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

import ChatFloatingComposer from "./ChatFloatingComposer";
import { ChatSessionContext } from "./ChatSessionContext";
import { ChatViewHistorySurface } from "./ChatViewHistorySurface";
import { ChatViewPostHistoryOverlays } from "./ChatViewPostHistoryOverlays";
import type { ChatViewProps } from "./ChatViewTypes";
import {
  buildCompactFilesReloadKey,
  countChatRounds,
} from "./InputArea/components/compactFileChangesHelpers";
import { useComposerSections } from "./InputArea/hooks/useComposerSections";
import { resolveInitialFileChanges } from "./chatViewFileChanges";
import { useBrowserAddToConversationAction } from "./hooks/useBrowserAddToConversationAction";
import { useChatViewAgentOrgSurface } from "./hooks/useChatViewAgentOrgSurface";
import { useChatViewAgentStationDiff } from "./hooks/useChatViewAgentStationDiff";
import { useChatViewCanvasPreview } from "./hooks/useChatViewCanvasPreview";
import { useChatViewFilesMenu } from "./hooks/useChatViewFilesMenu";
import { useChatViewFloatingComposerInset } from "./hooks/useChatViewFloatingComposerInset";
import { useChatViewOrgtrackSummary } from "./hooks/useChatViewOrgtrackSummary";
import { useChatViewPipelineClaim } from "./hooks/useChatViewPipelineClaim";
import { useChatViewPlanPillState } from "./hooks/useChatViewPlanPillState";
import { useChatViewScrollToBottom } from "./hooks/useChatViewScrollToBottom";
import { useFollowAgent } from "./hooks/useFollowAgent";
import type { SubmitOverrideInput } from "./hooks/useInputArea/types";

const logger = createLogger("ChatView");

const EMPTY_CHAT_EVENTS: SessionEvent[] = [];

export type { ChatViewProps } from "./ChatViewTypes";

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
    // Sources whose CLI cannot reopen a session (Cursor IDE, Windsurf,
    // Trae, …) are pure read-only replays: no composer, no continuation
    // affordance. Only CLI-continuable histories offer the fork composer.
    const importedCliResume = getImportedHistoryCliResume(sessionId);
    const showExternalHistoryForkComposer =
      isImportedHistory && !readOnly && Boolean(importedCliResume);
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
    const { setMeasuredFloatingComposerRef, historyBottomInset } =
      useChatViewFloatingComposerInset(showFloatingComposer);
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
    const canvasPreviewPill = useChatViewCanvasPreview(sessionId, snapshot);
    const currentPlanApproval = usePendingPlanApproval(sessionId);
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
          <ChatViewPostHistoryOverlays
            showExternalHistoryForkComposer={showExternalHistoryForkComposer}
            composerRef={setMeasuredFloatingComposerRef}
            position={position}
            onSubmitOverride={handleExternalHistoryForkSubmit}
            externalScrollToBottomButton={externalScrollToBottomButton}
            isImportedHistory={isImportedHistory}
            sessionId={sessionId}
          />
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
              agentOrgIntervention={agentOrgInterventionSlot}
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
