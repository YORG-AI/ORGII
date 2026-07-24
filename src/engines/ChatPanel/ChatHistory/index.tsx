/**
 * ChatHistory orchestrates session state, projection, navigation, viewport,
 * actions and the render-only view. Each concern owns its internal effects in
 * a focused hook so this entry point only wires their contracts together.
 */
import { useAtomValue } from "jotai";
import React, { useCallback, useEffect, useState } from "react";

import { resolveExternalReplayTarget } from "@src/api/tauri/externalHistory/replay";
import { isSessionActiveAtom } from "@src/store/session/cliSessionStatusAtom";
import { externalReplayTurnSummariesAtomFamily } from "@src/store/session/externalReplayTurnSummariesAtom";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";

import { useChatSessionId } from "../ChatSessionContext";
import {
  type ChatHistoryProps,
  EMPTY_BROWSER_ADD_TO_CONVERSATION_NAV,
  EMPTY_FOLLOW_AGENT_NAV,
} from "./ChatHistory.types";
import { useGroupChatContext } from "./GroupChatView/GroupChatContext";
import ChatHistoryView from "./components/ChatHistoryView";
import {
  useChatEmptyState,
  useChatHistoryItemActions,
  useChatHistoryProjectionModel,
  useChatHistoryState,
  useChatNavigationController,
  useChatSearchIntegration,
  useChatViewportController,
  useReloadSession,
} from "./hooks";
import "./index.scss";

export type {
  BrowserAddToConversationNavState,
  ChatHistoryProps,
  FollowAgentNavState,
  ScrollNavState,
} from "./ChatHistory.types";

const EMPTY_ORG_MEMBERS: ChatHistoryProps["agentOrgMembers"] = [];

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
  const activeId = useChatSessionId() ?? null;
  const rawExternalReplayTurnSummaries = useAtomValue(
    externalReplayTurnSummariesAtomFamily(activeId ?? "")
  );
  const activeSession = useAtomValue(sessionByIdAtom(activeId ?? ""));
  const isCursorIde = activeId ? isCursorIdeSession(activeId) : false;
  const externalReplayTurnSummaries =
    activeId && resolveExternalReplayTarget(activeId)
      ? rawExternalReplayTurnSummaries
      : [];
  const handleReloadSession = useReloadSession(activeId);
  const historyState = useChatHistoryState();
  const isAgentWorking = useAtomValue(isSessionActiveAtom);
  const groupChat = useGroupChatContext();

  const [planningIndicatorCount, setPlanningIndicatorCount] = useState<0 | 1>(
    0
  );
  const handlePlanningIndicatorCount = useCallback((count: 0 | 1) => {
    setPlanningIndicatorCount((previous) =>
      previous === count ? previous : count
    );
  }, []);

  const projection = useChatHistoryProjectionModel({
    activeId,
    chatHistory: historyState.chatHistory,
    chatHistorySourceIsOverride: historyState.chatHistorySourceIsOverride,
    chatHistorySourceSessionId: historyState.chatHistorySourceSessionId,
    chatHistorySourceVersion: historyState.chatHistorySourceVersion,
    externalReplayTurnSummaries,
    disableTailCollapse,
    forceCollapseAllTurns,
    groupChat,
    hideGroupUserMessage,
    isAgentWorking,
    isCursorIde,
    planningIndicatorCount,
    sessionStatus: activeSession?.status,
    sessionLoadStatus: historyState.sessionLoadStatus,
    turnPaginationEnabled,
  });
  const navigation = useChatNavigationController({
    activeId,
    agentOrgOverviewAvailable: Boolean(agentOrgOverviewPanel),
    currentPageIndex: projection.currentPageIndex,
    displayGroupCounts: projection.displayGroupCounts,
    displayGroupHeaders: projection.displayGroupHeaders,
    displayGroupMeta: projection.displayGroupMeta,
    displaySourceGroupIndices: projection.displaySourceGroupIndices,
    displayTotalFlatItems: projection.displayTotalFlatItems,
    pages: projection.pages,
    setTurnPageListOpen: projection.setTurnPageListOpen,
    setTurnPageSortAscending: projection.setTurnPageSortAscending,
    turnPageListOpen: projection.turnPageListOpen,
    turnPaginationEnabled,
    virtualListRef: historyState.virtualListRef,
  });
  const emptyState = useChatEmptyState({
    activeSessionId: activeId,
    sessionLoadStatus: historyState.sessionLoadStatus,
    optimizedLen: historyState.chatHistory.length,
  });
  const search = useChatSearchIntegration({
    chatHistory: historyState.chatHistory,
    optimizedChatHistory: projection.activeProjectionHistory,
    virtualListRef: historyState.virtualListRef,
    chatContainerRef: historyState.chatContainerRef,
    originalToFlatIndex: projection.originalToFlatIndex,
  });

  useEffect(() => {
    onRegisterSearchOpen?.(search.handleOpenSearch);
    return () => onRegisterSearchOpen?.(null);
  }, [onRegisterSearchOpen, search.handleOpenSearch]);

  const viewport = useChatViewportController({
    activeId,
    activeProjectionHistoryLength: projection.activeProjectionHistory.length,
    atBottom: historyState.atBottom,
    bottomInset,
    browserAddToConversationNav,
    currentPageIndex: projection.currentPageIndex,
    disableTailCollapse,
    displayGroupCounts: projection.displayGroupCounts,
    displayLastGroupFirstFlatIndex: projection.displayLastGroupFirstFlatIndex,
    displayTotalFlatItems: projection.displayTotalFlatItems,
    followAgentNav,
    isPendingCancelRef: emptyState.isPendingCancelRef,
    onScrollNavChange,
    planningIndicatorCount,
    sessionLoadStatus: historyState.sessionLoadStatus,
    setAtBottom: historyState.setAtBottom,
    setIsChatScrolledToBottom: historyState.setIsChatScrolledToBottom,
    setVisibleRange: historyState.setVisibleRange,
    tailFollowKey: projection.tailFollowKey,
    totalFlatItems: projection.totalFlatItems,
    turnPaginationEnabled,
  });
  const actions = useChatHistoryItemActions({
    displaySourceGroupIndices: projection.displaySourceGroupIndices,
    groupHeaders: projection.groupHeaders,
    handleIgnoreQuestionRef: historyState.handleIgnoreQuestionRef,
    handleReplyQuestionRef: historyState.handleReplyQuestionRef,
  });

  return (
    <ChatHistoryView
      actions={actions}
      activeId={activeId}
      agentOrgCurrentMemberId={agentOrgCurrentMemberId}
      agentOrgCurrentMemberName={agentOrgCurrentMemberName}
      agentOrgMembers={agentOrgMembers}
      agentOrgOverviewPanel={agentOrgOverviewPanel}
      bottomInset={bottomInset}
      chatPanelPosition={chatPanelPosition}
      displayMode={displayMode}
      emptyState={emptyState}
      groupChatEnabled={Boolean(groupChat?.enabled)}
      groupChatViewActive={groupChatViewActive}
      groupChatViewAvailable={groupChatViewAvailable}
      handlePlanningIndicatorCount={handlePlanningIndicatorCount}
      handleReloadSession={handleReloadSession}
      hideGroupUserMessage={hideGroupUserMessage}
      historyState={historyState}
      mutationActionsDisabled={mutationActionsDisabled}
      navigation={navigation}
      newEventDividerLabel={newEventDividerLabel}
      onAgentOrgMemberSelect={onAgentOrgMemberSelect}
      onAgentOrgRunViewRefresh={onAgentOrgRunViewRefresh}
      onGroupChatViewToggle={onGroupChatViewToggle}
      paginationTrailingSlot={paginationTrailingSlot}
      pinnedHeaderPortalHost={pinnedHeaderPortalHost}
      planningIndicatorScope={planningIndicatorScope}
      projection={projection}
      search={search}
      surfaceBgClass={surfaceBgClass}
      turnPaginationEnabled={turnPaginationEnabled}
      viewport={viewport}
    />
  );
};

ChatHistory.displayName = "ChatHistory";

export default ChatHistory;
