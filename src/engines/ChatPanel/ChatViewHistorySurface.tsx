import React from "react";

import type {
  AgentOrgRunMemberView,
  AgentOrgRunView,
} from "@src/api/tauri/agent";
import { AgentMessageClampProvider } from "@src/engines/ChatPanel/blocks/AgentMessageBlock";
import { AgentOrgGroupChatLiveSessions } from "@src/engines/ChatPanel/hooks/useAgentOrgGroupChatLiveSessions";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import ChatHistory from "./ChatHistory";
import type { ChatHistoryProps } from "./ChatHistory/ChatHistory.types";
import { GroupChatProvider } from "./ChatHistory/GroupChatView/GroupChatContext";
import { AgentEventsTap } from "./ChatHistory/GroupChatView/useGroupChatMergedEvents";
import { ConversationStreamProvider } from "./ConversationStreamProvider";
import AgentOrgOverviewPanel from "./InputArea/components/AgentOrgOverviewPanel";

interface ChatViewHistorySurfaceProps {
  sessionId: string;
  groupChatViewActive: boolean;
  groupChatMergedEvents: SessionEvent[];
  groupChatAgents: ReadonlyArray<{ sessionId: string }>;
  pipelineSessionId: string | null;
  handleGroupChatTapEvents: (sessionId: string, events: SessionEvent[]) => void;
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
  groupChatMergedEvents,
  groupChatAgents,
  pipelineSessionId,
  handleGroupChatTapEvents,
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
  return (
    <ConversationStreamProvider
      sessionId={sessionId}
      overrideEvents={groupChatViewActive ? groupChatMergedEvents : undefined}
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
      </GroupChatProvider>
    </ConversationStreamProvider>
  );
}
