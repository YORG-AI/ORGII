/**
 * useChatViewAgentOrgSurface
 *
 * Bundles the Agent-Org / group-chat derived state that ChatView threads
 * through ChatViewHistorySurface, ChatFloatingComposer and the pagination
 * bar's trailing action: run-view fetch, current-member resolution, the
 * group-chat controller, message-queue wiring, and the intervention banner.
 * Kept as one hook (mirroring `useAgentOrgGroupChatController`'s own
 * kitchen-sink shape) because these pieces share the same `agentOrgRunView`
 * fetch and `currentAgentOrgMember` resolution and are otherwise painful to
 * split without re-fetching or re-deriving state.
 */
import { useAtomValue } from "jotai";
import { useMemo } from "react";

import { GroupChatPausedBanner } from "@src/engines/ChatPanel/components/ChatStatusBanners";
import type { ConversationRootLocator } from "@src/engines/SessionCore/conversations/conversationTypes";
import { activeSessionIdAtom } from "@src/store/session";

import { ChatViewGroupChatHistoryAction } from "../ChatViewGroupChatHistoryAction";
import { useAgentOrgIntervention } from "../InputArea/components/useAgentOrgIntervention";
import { useAgentOrgMemberSessionJump } from "../InputArea/components/useAgentOrgMemberSessionJump";
import { useAgentOrgRunView } from "../InputArea/components/useAgentOrgRunView";
import { useAgentOrgGroupChatController } from "./useAgentOrgGroupChatController";
import { useChatViewMessageQueue } from "./useChatViewMessageQueue";

export function useChatViewAgentOrgSurface({
  sessionId,
  showCurrentPlanSurface,
  conversationRoot,
}: {
  sessionId: string;
  showCurrentPlanSurface: boolean;
  conversationRoot: ConversationRootLocator | null;
}) {
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
    retryFailedGroupChatMessage,
  } = useAgentOrgGroupChatController({
    sessionId,
    agentOrgRunView,
    currentAgentOrgMember,
    refreshAgentOrgRunView,
  });

  const handleAgentOrgMemberSessionJump =
    useAgentOrgMemberSessionJump(sessionId);

  const {
    cancelQueuedMessage,
    queueTailKey,
    handleClearSessionQueue,
    handleReorderSessionQueue,
    handleSendNow,
    queueEditProps,
    sessionMessageQueue,
  } = useChatViewMessageQueue({
    pipelineSessionId,
    queueSessionId,
    conversationRoot,
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

  const hasAgentOrgIntervention =
    agentOrgInterventionError !== null || agentOrgIntervention !== null;
  const agentOrgInterventionSlot = hasAgentOrgIntervention
    ? {
        intervention: agentOrgIntervention,
        memberName: currentAgentOrgMember?.name,
        error: agentOrgInterventionError,
        returning: agentOrgInterventionReturning,
        onReturnToWork: returnAgentOrgMemberToWork,
      }
    : null;

  const groupChatHistoryAction = (
    <ChatViewGroupChatHistoryAction
      groupChatViewActive={groupChatViewActive}
      groupChatHistoryError={groupChatHistoryError}
      groupChatHistoryHasMore={groupChatHistoryHasMore}
      groupChatHistoryLoading={groupChatHistoryLoading}
      onRetry={retryGroupChatHistory}
      onLoadOlder={() => void loadOlderGroupChatHistory()}
    />
  );

  return {
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
    handleMainComposerSubmitOverride: handleGroupChatSubmitOverride,
    retryFailedGroupChatMessage,
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
  };
}
