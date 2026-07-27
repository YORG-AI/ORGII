import React, { useCallback, useMemo } from "react";
import { createPortal } from "react-dom";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { ChatLoadingBlock } from "@src/engines/ChatPanel/blocks/primitives";
import type { ChatHistoryDisplayMode } from "@src/store/ui/chatPanelAtom";

import SessionHeader from "../../ChatItems/SessionHeader";
import { ChatHistoryDisplayModeProvider } from "../chatDisplayModeContext";
import type { UseChatEmptyStateReturn } from "../hooks/useChatEmptyState";
import type { useChatHistoryItemActions } from "../hooks/useChatHistoryItemActions";
import type { useChatHistoryProjectionModel } from "../hooks/useChatHistoryProjectionModel";
import type { UseChatHistoryStateReturn } from "../hooks/useChatHistoryState";
import type { useChatNavigationController } from "../hooks/useChatNavigationController";
import type { UseChatSearchIntegrationReturn } from "../hooks/useChatSearchIntegration";
import type { useChatViewportController } from "../hooks/useChatViewportController";
import { useGroupHeaderRenderer } from "../hooks/useGroupHeaderRenderer";
import type { useReloadSession } from "../hooks/useReloadSession";
import ChatHistoryEmptyState from "./ChatHistoryEmptyState";
import ChatPinnedHeaderLayer from "./ChatPinnedHeaderLayer";
import ChatSearchBar from "./ChatSearchBar";
import ConversationMinimap from "./ConversationMinimap";
import PlanningIndicatorBridge from "./PlanningIndicatorBridge";
import RevertConfirmDialog from "./RevertConfirmDialog";
import TurnMetadataLoader from "./TurnMetadataLoader";
import TurnPageList from "./TurnPageList";

type ProjectionModel = ReturnType<typeof useChatHistoryProjectionModel>;
type NavigationModel = ReturnType<typeof useChatNavigationController>;
type ViewportModel = ReturnType<typeof useChatViewportController>;
type ActionsModel = ReturnType<typeof useChatHistoryItemActions>;

const BOTTOM_OVERLAY_FADE_PX = 32;
const VIRTUALIZED_BODY_STYLE: React.CSSProperties = {
  backfaceVisibility: "hidden",
  contain: "layout paint",
  transform: "translateZ(0)",
  willChange: "transform",
};
const renderNoGroupHeader = () => <div aria-hidden style={{ minHeight: 1 }} />;

interface ChatHistoryViewProps {
  actions: ActionsModel;
  activeId: string | null;
  agentOrgCurrentMemberId: string | null;
  agentOrgCurrentMemberName: string | null;
  agentOrgMembers: AgentOrgRunMemberView[];
  agentOrgOverviewPanel?: React.ReactNode;
  bottomInset: number;
  chatPanelPosition: "left" | "right";
  displayMode: ChatHistoryDisplayMode;
  emptyState: UseChatEmptyStateReturn;
  groupChatEnabled: boolean;
  groupChatViewActive: boolean;
  groupChatViewAvailable: boolean;
  handlePlanningIndicatorCount: (count: 0 | 1) => void;
  handleReloadSession: ReturnType<typeof useReloadSession>;
  hideGroupUserMessage: boolean;
  historyState: UseChatHistoryStateReturn;
  mutationActionsDisabled: boolean;
  navigation: NavigationModel;
  newEventDividerLabel: string | null;
  onAgentOrgMemberSelect?: (member: AgentOrgRunMemberView) => void;
  onAgentOrgRunViewRefresh?: () => Promise<void>;
  onGroupChatViewToggle?: (active: boolean) => void;
  paginationTrailingSlot?: React.ReactNode;
  pinnedHeaderPortalHost: HTMLElement | null;
  planningIndicatorScope: { sessionId: string; isLive: boolean } | null;
  projection: ProjectionModel;
  search: UseChatSearchIntegrationReturn;
  surfaceBgClass: string;
  turnPaginationEnabled: boolean;
  viewport: ViewportModel;
}

const ChatHistoryView: React.FC<ChatHistoryViewProps> = ({
  actions,
  activeId,
  agentOrgCurrentMemberId,
  agentOrgCurrentMemberName,
  agentOrgMembers,
  agentOrgOverviewPanel,
  bottomInset,
  chatPanelPosition,
  displayMode,
  emptyState,
  groupChatEnabled,
  groupChatViewActive,
  groupChatViewAvailable,
  handlePlanningIndicatorCount,
  handleReloadSession,
  hideGroupUserMessage,
  historyState,
  mutationActionsDisabled,
  navigation,
  newEventDividerLabel,
  onAgentOrgMemberSelect,
  onAgentOrgRunViewRefresh,
  onGroupChatViewToggle,
  paginationTrailingSlot,
  pinnedHeaderPortalHost,
  planningIndicatorScope,
  projection,
  search,
  surfaceBgClass,
  turnPaginationEnabled,
  viewport,
}) => {
  const {
    chatHistory,
    chatContainerRef,
    virtualListRef,
    chatFontSize,
    chatCodeFontSize,
    chatLineHeight,
    codeBlockContainerWidth,
    sessionLoadStatus,
    sessionLoadError,
    isWpGeneWorkingRef,
    isExploringRef,
  } = historyState;
  const {
    activeProjectionHistory,
    collapseTailWhenIdle,
    currentPageIndex,
    currentTurnPageLabel,
    currentTurnPageTimeLabel,
    defaultTurnCollapsed,
    displayFlatItems,
    displayGroupCounts,
    displayGroupHeaders,
    displayGroupMeta,
    displayLastAssistantFlatIndexPerItem,
    displaySourceGroupIndices,
    displayTotalFlatItems,
    displayTurnIds,
    groupCounts,
    groupHeaders,
    groupMeta,
    handleLastTurnPage,
    handleNextTurnPage,
    handlePreviousTurnPage,
    pageCount,
    pages,
    planningIndicatorEnabled,
    projection: projectionResult,
    selectTurnPage,
    setTurnPageListOpen,
    setTurnPageSortAscending,
    turnMetadataReloadKey,
    turnPageListOpen,
    turnPageSortAscending,
    turnPaginationReady,
    virtualListDataKey,
  } = projection;
  const {
    activeGroupIndex,
    activePinnedHeader,
    activePinnedMeta,
    activePinnedSourceGroupIndex,
    agentOrgOverviewOpen,
    conversationHistoryPageIndex,
    handleActiveGroupIndexChange,
    handleConversationHistoryClose,
    handleConversationHistorySelect,
    handleConversationHistorySortToggle,
    handleConversationHistoryToggle,
    handleConversationMinimapNavigate,
    setAgentOrgOverviewOpen,
    showPinnedTurnHeader,
    visibleGroupIndices,
  } = navigation;
  const {
    conversationMinimapScrolling,
    footerSpacerHeight,
    handleChatListScrollStateChange,
    handleRangeChanged,
    handleTurnPageEndReached,
    isLoadingMore,
    scrollAreaRef,
    staticScrollerRef,
    turnCollapseInteractionAtRef,
    virtuosoScrollerRef,
  } = viewport;
  const {
    handleEditUserMessage,
    handleHeaderRestoreCheckpoint,
    handleIgnoreQuestion,
    handlePinnedEditSubmit,
    handleRegenerateGroup,
    handleSubmitAnswers,
  } = actions;
  const {
    search: searchState,
    isSearchVisible,
    searchBarRef,
    handleCloseSearch,
  } = search;

  const getIsWpGeneWorking = useCallback(
    () => isWpGeneWorkingRef.current ?? false,
    [isWpGeneWorkingRef]
  );
  const getIsExploring = useCallback(
    () => isExploringRef.current ?? false,
    [isExploringRef]
  );
  const renderGroupHeader = useGroupHeaderRenderer({
    displaySourceGroupIndices,
    sourceGroupCount: groupCounts.length,
    displayGroupHeaders,
    displayGroupMeta,
    displayGroupCount: displayGroupCounts.length,
    collapseLabelVariant: groupChatEnabled ? "agents" : "agent",
    turnPaginationEnabled,
    collapseTailWhenIdle,
    hideUserMessage: hideGroupUserMessage,
    defaultTurnCollapsed,
    turnCollapseInteractionAtRef,
    onEditSubmit: mutationActionsDisabled ? undefined : handleEditUserMessage,
    onRestoreCheckpoint: mutationActionsDisabled
      ? undefined
      : handleHeaderRestoreCheckpoint,
  });
  const renderModeItemCount = useMemo(
    () =>
      displayGroupMeta.reduce(
        (total, meta) =>
          total + (meta.unloadedTurn?.bodyEventCount ?? meta.itemCount),
        0
      ),
    [displayGroupMeta]
  );
  const sessionInfo = useMemo(() => {
    const start = chatHistory.find(
      (event) => event.actionType === "session_start"
    );
    if (!start) return null;
    return {
      sessionId: start.sessionId,
      model:
        (start.args?.model as string) || (start.result?.model as string) || "",
      startedAt: start.createdAt,
    };
  }, [chatHistory]);
  const chatHistoryContainerStyle = useMemo<React.CSSProperties>(
    () =>
      ({
        minHeight: 0,
        fontSize: `${chatFontSize}px`,
        lineHeight: chatLineHeight ?? 1.6,
        "--chat-font-size": `${chatFontSize}px`,
        "--chat-code-font-size": `${chatCodeFontSize ?? 13}px`,
        "--chat-line-height": chatLineHeight ?? 1.6,
      }) as React.CSSProperties,
    [chatFontSize, chatCodeFontSize, chatLineHeight]
  );
  const showTurnContextRow =
    turnPaginationEnabled ||
    Boolean(agentOrgCurrentMemberName) ||
    Boolean(agentOrgOverviewPanel);
  const pinnedHeaderLayer = (
    <ChatPinnedHeaderLayer
      showTurnContextRow={showTurnContextRow}
      agentName={agentOrgCurrentMemberName}
      currentMemberId={agentOrgCurrentMemberId}
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
      onPreviousTurnPage={handlePreviousTurnPage}
      onNextTurnPage={handleNextTurnPage}
      onLastTurnPage={handleLastTurnPage}
      trailingActions={paginationTrailingSlot}
      groupChatViewAvailable={groupChatViewAvailable}
      groupChatViewActive={groupChatViewActive}
      onGroupChatViewToggle={onGroupChatViewToggle}
      showPinnedTurnHeader={showPinnedTurnHeader}
      sourceGroupIndex={activePinnedSourceGroupIndex}
      sourceGroupCount={groupCounts.length}
      header={activePinnedHeader}
      meta={activePinnedMeta}
      collapseLabelVariant={groupChatEnabled ? "agents" : "agent"}
      collapseTailWhenIdle={collapseTailWhenIdle}
      hideUserMessage={hideGroupUserMessage}
      defaultTurnCollapsed={defaultTurnCollapsed}
      turnCollapseInteractionAtRef={turnCollapseInteractionAtRef}
      onEditSubmit={
        mutationActionsDisabled ? undefined : handlePinnedEditSubmit
      }
      onRestoreCheckpoint={
        mutationActionsDisabled ? undefined : handleHeaderRestoreCheckpoint
      }
    />
  );

  return (
    <ChatHistoryDisplayModeProvider value={displayMode}>
      <div
        className="wp__chat__history relative z-20 flex h-full min-w-0 max-w-full flex-1 flex-col self-stretch overflow-hidden"
        data-testid="chat-message-list"
        data-chat-history-count={chatHistory.length}
        data-optimized-count={activeProjectionHistory.length}
        data-flat-count={displayTotalFlatItems}
        data-group-shape={projectionResult.groupShapeDigest}
        ref={chatContainerRef as React.RefObject<HTMLDivElement>}
        style={chatHistoryContainerStyle}
      >
        <div className={DETAIL_PANEL_TOKENS.contentWidth}>
          <SessionHeader sessionInfo={sessionInfo} />
        </div>

        <ChatSearchBar
          ref={searchBarRef}
          search={searchState}
          isVisible={isSearchVisible}
          onClose={handleCloseSearch}
        />

        {pinnedHeaderPortalHost
          ? createPortal(
              <div
                className="chat-history-portal"
                style={chatHistoryContainerStyle}
              >
                {pinnedHeaderLayer}
              </div>,
              pinnedHeaderPortalHost
            )
          : pinnedHeaderLayer}

        <div className="flex min-h-0 flex-1 flex-col">
          {agentOrgOverviewOpen && agentOrgOverviewPanel && (
            <div
              className={`max-h-[45%] flex-shrink-0 overflow-y-auto scrollbar-hide ${surfaceBgClass}`}
            >
              <div
                className={`mx-auto w-full px-2 pb-2 ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
              >
                <div
                  data-agent-org-overview-panel="true"
                  className={`${DROPDOWN_CLASSES.panel} p-1`}
                >
                  {agentOrgOverviewPanel}
                </div>
              </div>
            </div>
          )}

          <div
            className="relative min-h-0 flex-1 @container/chatbody"
            style={VIRTUALIZED_BODY_STYLE}
            data-chat-virtualized-body-layer
          >
            {!turnPaginationEnabled &&
              !turnPageListOpen &&
              !agentOrgOverviewOpen && (
                <ConversationMinimap
                  groupHeaders={displayGroupHeaders}
                  groupMeta={displayGroupMeta}
                  groupCounts={displayGroupCounts}
                  flatItems={displayFlatItems}
                  chatPanelPosition={chatPanelPosition}
                  activeGroupIndex={activeGroupIndex}
                  visibleGroupIndices={visibleGroupIndices}
                  isAtBottom={historyState.atBottom}
                  isScrolling={conversationMinimapScrolling}
                  labelVariant={groupChatEnabled ? "agents" : "agent"}
                  onNavigate={handleConversationMinimapNavigate}
                  onHistoryToggle={handleConversationHistoryToggle}
                />
              )}

            {turnPageListOpen &&
              (turnPaginationEnabled
                ? turnPaginationReady
                : pages.length > 0) && (
                <TurnPageList
                  surfaceBgClass={surfaceBgClass}
                  bottomInset={bottomInset}
                  pages={pages}
                  groupHeaders={groupHeaders}
                  groupMeta={groupMeta}
                  currentPageIndex={conversationHistoryPageIndex}
                  turnPageSortAscending={turnPageSortAscending}
                  onSelectTurnPage={
                    turnPaginationEnabled
                      ? selectTurnPage
                      : handleConversationHistorySelect
                  }
                  onToggleSort={
                    turnPaginationEnabled
                      ? undefined
                      : handleConversationHistorySortToggle
                  }
                  onClose={
                    turnPaginationEnabled
                      ? undefined
                      : handleConversationHistoryClose
                  }
                />
              )}

            {isLoadingMore && (
              <div
                className={`absolute left-0 right-0 top-0 z-20 mx-auto ${surfaceBgClass} p-2 ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
              >
                <ChatLoadingBlock />
              </div>
            )}

            {bottomInset > 0 && (
              <div
                className="pointer-events-none absolute bottom-0 left-0 right-0 z-10"
                style={{
                  height: bottomInset,
                  maskImage: `linear-gradient(to bottom, transparent 0, black ${BOTTOM_OVERLAY_FADE_PX}px)`,
                  WebkitMaskImage: `linear-gradient(to bottom, transparent 0, black ${BOTTOM_OVERLAY_FADE_PX}px)`,
                }}
              >
                <div className={`h-full w-full ${surfaceBgClass}`} />
              </div>
            )}

            <div
              ref={scrollAreaRef}
              className="absolute inset-0 overflow-hidden"
            >
              <div className="h-full w-full">
                {activeProjectionHistory.length > 0 ? (
                  <>
                    <TurnMetadataLoader
                      sessionId={activeId}
                      reloadKey={turnMetadataReloadKey}
                      turnIds={displayTurnIds}
                    />
                    <PlanningIndicatorBridge
                      planningIndicatorScope={planningIndicatorScope}
                      planningIndicatorEnabled={planningIndicatorEnabled}
                      onPlanningIndicatorCount={handlePlanningIndicatorCount}
                      flatItems={displayFlatItems}
                      groupCounts={displayGroupCounts}
                      turnIds={displayTurnIds}
                      totalFlatItems={displayTotalFlatItems}
                      renderModeItemCount={renderModeItemCount}
                      lastAssistantFlatIndexPerItem={
                        displayLastAssistantFlatIndexPerItem
                      }
                      codeBlockContainerWidth={codeBlockContainerWidth ?? 0}
                      footerSpacerHeight={footerSpacerHeight}
                      bottomInset={bottomInset}
                      virtualListRef={virtualListRef}
                      virtualListDataKey={virtualListDataKey}
                      getIsWpGeneWorking={getIsWpGeneWorking}
                      getIsExploring={getIsExploring}
                      renderGroupHeader={
                        turnPaginationEnabled
                          ? renderNoGroupHeader
                          : renderGroupHeader
                      }
                      onAtBottomStateChange={handleChatListScrollStateChange}
                      onRangeChanged={handleRangeChanged}
                      onActiveGroupIndexChange={handleActiveGroupIndexChange}
                      hideActiveGroupHeader={turnPaginationEnabled}
                      onEndReached={handleTurnPageEndReached}
                      onRegenerate={
                        mutationActionsDisabled
                          ? undefined
                          : handleRegenerateGroup
                      }
                      onSubmit={handleSubmitAnswers}
                      onSkip={handleIgnoreQuestion}
                      onEditUserMessage={
                        mutationActionsDisabled
                          ? undefined
                          : handleEditUserMessage
                      }
                      virtualScrollerRef={virtuosoScrollerRef}
                      staticScrollerRef={staticScrollerRef}
                      newEventDividerLabel={newEventDividerLabel}
                    />
                  </>
                ) : (
                  <ChatHistoryEmptyState
                    sessionLoadStatus={sessionLoadStatus}
                    sessionLoadError={sessionLoadError}
                    emptyConfirmed={emptyState.emptyConfirmed}
                    shouldShowEmpty={emptyState.shouldShowEmpty}
                    isRolledBack={emptyState.isRolledBack}
                    projectionPending={
                      projectionResult.pending && chatHistory.length > 0
                    }
                    onReload={handleReloadSession}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
        <RevertConfirmDialog />
      </div>
    </ChatHistoryDisplayModeProvider>
  );
};

ChatHistoryView.displayName = "ChatHistoryView";

export default ChatHistoryView;
