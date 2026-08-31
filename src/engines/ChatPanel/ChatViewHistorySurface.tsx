import React from "react";

import type {
  AgentOrgGroupConversationItem,
  AgentOrgGroupProjectionItem,
  AgentOrgRunMemberView,
  AgentOrgRunView,
} from "@src/api/tauri/agent";
import { AgentMessageClampProvider } from "@src/engines/ChatPanel/blocks/AgentMessageBlock";

import ChatHistory from "./ChatHistory";
import type { ChatHistoryProps } from "./ChatHistory/ChatHistory.types";
import AgentOrgGroupProjectionView from "./ChatHistory/GroupChatView/AgentOrgGroupProjectionView";
import { ConversationStreamProvider } from "./ConversationStreamProvider";
import AgentOrgOverviewPanel from "./InputArea/components/AgentOrgOverviewPanel";

interface ChatViewHistorySurfaceProps {
  sessionId: string;
  groupChatViewActive: boolean;
  groupProjectionItems: AgentOrgGroupProjectionItem[];
  groupProjectionHasMore: boolean;
  groupProjectionLoading: boolean;
  groupProjectionError: string | null;
  groupProjectionActionError: string | null;
  actionPendingTurns: ReadonlySet<string>;
  pipelineSessionId: string | null;
  loadOlderGroupProjection: () => Promise<void>;
  retryGroupProjection: () => Promise<void>;
  handleStopGroupDelivery: (
    item: AgentOrgGroupConversationItem
  ) => Promise<void>;
  handleRetryGroupDelivery: (
    item: AgentOrgGroupConversationItem
  ) => Promise<void>;
  agentMessageClampEligible: boolean;
  surfaceBgClass: string;
  position: "left" | "right";
  currentAgentOrgMember: AgentOrgRunMemberView | null;
  agentOrgRunView: AgentOrgRunView | null;
  agentOrgRunViewError: string | null;
  refreshAgentOrgRunView: () => Promise<void>;
  handleAgentOrgMemberSessionJump: (member: AgentOrgRunMemberView) => void;
  handleScrollNavChange: NonNullable<ChatHistoryProps["onScrollNavChange"]>;
  followAgentNav: ChatHistoryProps["followAgentNav"];
  browserAddToConversationNav: ChatHistoryProps["browserAddToConversationNav"];
  displayMode: ChatHistoryProps["displayMode"];
  turnPaginationEnabled: boolean;
  paginationTrailingSlot: ChatHistoryProps["paginationTrailingSlot"];
  pinnedHeaderHost: HTMLDivElement | null;
  chromeTopInset: number;
  historyBottomInset: number;
  groupChatViewAvailable: boolean;
  handleGroupChatViewToggle: NonNullable<
    ChatHistoryProps["onGroupChatViewToggle"]
  >;
  isReadOnlySurface: boolean;
}

export function ChatViewHistorySurface({
  sessionId,
  groupChatViewActive,
  groupProjectionItems,
  groupProjectionHasMore,
  groupProjectionLoading,
  groupProjectionError,
  groupProjectionActionError,
  actionPendingTurns,
  pipelineSessionId,
  loadOlderGroupProjection,
  retryGroupProjection,
  handleStopGroupDelivery,
  handleRetryGroupDelivery,
  agentMessageClampEligible,
  surfaceBgClass,
  position,
  currentAgentOrgMember,
  agentOrgRunView,
  agentOrgRunViewError,
  refreshAgentOrgRunView,
  handleAgentOrgMemberSessionJump,
  handleScrollNavChange,
  followAgentNav,
  browserAddToConversationNav,
  displayMode,
  turnPaginationEnabled,
  paginationTrailingSlot,
  pinnedHeaderHost,
  chromeTopInset,
  historyBottomInset,
  groupChatViewAvailable,
  handleGroupChatViewToggle,
  isReadOnlySurface,
}: ChatViewHistorySurfaceProps) {
  if (groupChatViewActive && agentOrgRunView) {
    return (
      <AgentOrgGroupProjectionView
        items={groupProjectionItems}
        members={agentOrgRunView.members}
        runStatus={agentOrgRunView.runStatus}
        loading={groupProjectionLoading}
        hasMore={groupProjectionHasMore}
        error={groupProjectionError}
        actionError={groupProjectionActionError}
        actionPendingTurns={actionPendingTurns}
        overviewPanel={
          <AgentOrgOverviewPanel
            view={agentOrgRunView}
            error={agentOrgRunViewError}
            currentSessionId={sessionId}
            onRefresh={refreshAgentOrgRunView}
          />
        }
        bottomInset={historyBottomInset}
        onExitGroup={() => handleGroupChatViewToggle(false)}
        onMemberSelect={handleAgentOrgMemberSessionJump}
        onLoadOlder={loadOlderGroupProjection}
        onRetryLoad={retryGroupProjection}
        onStop={handleStopGroupDelivery}
        onRetry={handleRetryGroupDelivery}
      />
    );
  }

  return (
    <ConversationStreamProvider
      sessionId={sessionId}
      overrideEvents={undefined}
    >
      <AgentMessageClampProvider value={agentMessageClampEligible}>
        <ChatHistory
          surfaceBgClass={surfaceBgClass}
          chatPanelPosition={position}
          agentOrgCurrentMemberName={currentAgentOrgMember?.name ?? null}
          agentOrgCurrentMemberId={currentAgentOrgMember?.memberId ?? null}
          agentOrgMembers={agentOrgRunView?.members ?? []}
          mutationActionsDisabled={isReadOnlySurface}
          agentOrgOverviewPanel={
            agentOrgRunView || agentOrgRunViewError ? (
              <AgentOrgOverviewPanel
                view={agentOrgRunView}
                error={agentOrgRunViewError}
                currentSessionId={
                  groupChatViewActive
                    ? sessionId
                    : (pipelineSessionId ?? sessionId)
                }
                onRefresh={refreshAgentOrgRunView}
              />
            ) : null
          }
          onAgentOrgMemberSelect={handleAgentOrgMemberSessionJump}
          onAgentOrgRunViewRefresh={refreshAgentOrgRunView}
          onScrollNavChange={handleScrollNavChange}
          followAgentNav={followAgentNav}
          browserAddToConversationNav={browserAddToConversationNav}
          displayMode={displayMode}
          turnPaginationEnabled={turnPaginationEnabled}
          paginationTrailingSlot={paginationTrailingSlot}
          pinnedHeaderPortalHost={pinnedHeaderHost}
          chromeTopInset={chromeTopInset}
          bottomInset={historyBottomInset}
          groupChatViewAvailable={groupChatViewAvailable}
          groupChatViewActive={groupChatViewActive}
          onGroupChatViewToggle={handleGroupChatViewToggle}
        />
      </AgentMessageClampProvider>
    </ConversationStreamProvider>
  );
}
