import React, { memo } from "react";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";

import type { OptimizedChatItem } from "../chatItemPipeline/types";
import type { ChatGroupMeta } from "../hooks/useChatGroups";
import type { GroupHeaderRendererProps } from "../renderers/GroupHeaderRenderer";
import PinnedTurnHeader from "./PinnedTurnHeader";
import TurnPaginationControls from "./TurnPaginationControls";

interface ChatPinnedHeaderLayerProps {
  showTurnContextRow: boolean;
  agentName?: string | null;
  currentMemberId?: string | null;
  agentOrgMembers?: AgentOrgRunMemberView[];
  agentOrgOverviewPanel?: React.ReactNode;
  agentOrgOverviewOpen: boolean;
  setAgentOrgOverviewOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onAgentOrgMemberSelect?: (member: AgentOrgRunMemberView) => void;
  onAgentOrgRunViewRefresh?: () => Promise<void>;
  turnPaginationEnabled: boolean;
  turnPaginationReady: boolean;
  turnPageListOpen: boolean;
  setTurnPageListOpen: React.Dispatch<React.SetStateAction<boolean>>;
  turnPageSortAscending: boolean;
  setTurnPageSortAscending: React.Dispatch<React.SetStateAction<boolean>>;
  currentTurnPageLabel: string;
  currentTurnPageTimeLabel: string;
  currentPageIndex: number;
  pageCount: number;
  onPreviousTurnPage: () => void;
  onNextTurnPage: () => void;
  onLastTurnPage: () => void;
  trailingActions?: React.ReactNode;
  groupChatViewAvailable?: boolean;
  groupChatViewActive?: boolean;
  onGroupChatViewToggle?: (active: boolean) => void;
  showPinnedTurnHeader: boolean;
  sessionId: string | null;
  sourceGroupIndex?: number;
  sourceGroupCount: number;
  header: OptimizedChatItem | null | undefined;
  meta: ChatGroupMeta | undefined;
  hasPinnedContent: boolean;
  collapseLabelVariant?: GroupHeaderRendererProps["collapseLabelVariant"];
  collapseTailWhenIdle: boolean;
  hideUserMessage: boolean;
  defaultTurnCollapsed: boolean;
  turnCollapseInteractionAtRef: React.MutableRefObject<number>;
  onEditSubmit: GroupHeaderRendererProps["onEditSubmit"];
  onRestoreCheckpoint: GroupHeaderRendererProps["onRestoreCheckpoint"];
}

const ChatPinnedHeaderLayer: React.FC<ChatPinnedHeaderLayerProps> = memo(
  ({
    showTurnContextRow,
    agentName,
    currentMemberId,
    agentOrgMembers,
    agentOrgOverviewPanel,
    agentOrgOverviewOpen,
    setAgentOrgOverviewOpen,
    onAgentOrgMemberSelect,
    onAgentOrgRunViewRefresh,
    turnPaginationEnabled,
    turnPaginationReady,
    turnPageListOpen,
    setTurnPageListOpen,
    turnPageSortAscending,
    setTurnPageSortAscending,
    currentTurnPageLabel,
    currentTurnPageTimeLabel,
    currentPageIndex,
    pageCount,
    onPreviousTurnPage,
    onNextTurnPage,
    onLastTurnPage,
    trailingActions,
    groupChatViewAvailable,
    groupChatViewActive,
    onGroupChatViewToggle,
    showPinnedTurnHeader,
    sessionId,
    sourceGroupIndex,
    sourceGroupCount,
    header,
    meta,
    hasPinnedContent,
    collapseLabelVariant,
    collapseTailWhenIdle,
    hideUserMessage,
    defaultTurnCollapsed,
    turnCollapseInteractionAtRef,
    onEditSubmit,
    onRestoreCheckpoint,
  }) => {
    if (!showTurnContextRow && !showPinnedTurnHeader) return null;

    return (
      <div
        className="flex flex-shrink-0 flex-col"
        data-chat-pinned-header-layer
      >
        {showTurnContextRow && (
          <TurnPaginationControls
            agentName={agentName}
            currentMemberId={currentMemberId}
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
            onPreviousTurnPage={onPreviousTurnPage}
            onNextTurnPage={onNextTurnPage}
            onLastTurnPage={onLastTurnPage}
            trailingActions={trailingActions}
            groupChatViewAvailable={groupChatViewAvailable}
            groupChatViewActive={groupChatViewActive}
            onGroupChatViewToggle={onGroupChatViewToggle}
          />
        )}
        <PinnedTurnHeader
          visible={showPinnedTurnHeader}
          sessionId={sessionId}
          sourceGroupIndex={sourceGroupIndex}
          sourceGroupCount={sourceGroupCount}
          header={header}
          meta={meta}
          hasPinnedContent={hasPinnedContent}
          collapseLabelVariant={collapseLabelVariant}
          collapseTailWhenIdle={collapseTailWhenIdle}
          hideUserMessage={hideUserMessage}
          defaultTurnCollapsed={defaultTurnCollapsed}
          turnCollapseInteractionAtRef={turnCollapseInteractionAtRef}
          onEditSubmit={onEditSubmit}
          onRestoreCheckpoint={onRestoreCheckpoint}
        />
      </div>
    );
  }
);

ChatPinnedHeaderLayer.displayName = "ChatPinnedHeaderLayer";

export default ChatPinnedHeaderLayer;
