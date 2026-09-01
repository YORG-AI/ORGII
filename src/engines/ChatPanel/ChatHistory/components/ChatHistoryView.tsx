import React, { useCallback, useMemo } from "react";
import { createPortal } from "react-dom";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import { CHAT_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";
import { ChatLoadingBlock } from "@src/engines/ChatPanel/blocks/primitives";
import { resolveTranscriptTopPaddingPx } from "@src/engines/ChatPanel/header/chatPanelHeaderLayout";
import CloudSessionDownloadProgressCard from "@src/features/Org2Cloud/CloudSessionDownloadProgressCard";
import { useCloudSessionHasDownloadSurface } from "@src/features/Org2Cloud/useCloudSessionDownloadSurface";
import type { ChatHistoryDisplayMode } from "@src/store/ui/chatPanelAtom";

import SessionHeader from "../../ChatItems/SessionHeader";
import { ChatHistoryDisplayModeProvider } from "../chatDisplayModeContext";
import type { UseChatEmptyStateReturn } from "../hooks/useChatEmptyState";
import type { useChatHistoryItemActions } from "../hooks/useChatHistoryItemActions";
import type { useChatHistoryProjectionModel } from "../hooks/useChatHistoryProjectionModel";
import type { UseChatHistoryStateReturn } from "../hooks/useChatHistoryState";
import type { useChatNavigationController } from "../hooks/useChatNavigationController";
import type { UseChatSearchReturn } from "../hooks/useChatSearch";
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
  chromeTopInset: number;
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
  search: UseChatSearchReturn;
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
  chromeTopInset,
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
    resolveAssistantTurnCopyContent,
    selectTurnPage,
    setTurnPageListOpen,
    setTurnPageSortAscending,
    tailTurnPhase,
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

  const getIsWpGeneWorking = useCallback(
    () => isWpGeneWorkingRef.current ?? false,
    [isWpGeneWorkingRef]
  );
  const getIsExploring = useCallback(
    () => isExploringRef.current ?? false,
    [isExploringRef]
  );
  const hasCloudDownloadProgress = useCloudSessionHasDownloadSurface(activeId);
  const assistantCopyEventIdsByGroup = useMemo(
    () => displayGroupMeta.map((meta) => meta.assistantCopyEventIds),
    [displayGroupMeta]
  );
  // Anchor for the live status trail's elapsed readout. Read from the FULL
  // projection, not the current page: with turn pagination on, the visible
  // page may not hold the running round, and the trail is about that round.
  const tailTurnStartedAtMs = useMemo(
    () => groupMeta[groupMeta.length - 1]?.startMs ?? null,
    [groupMeta]
  );
  // Newest timestamped thing in the transcript, for the trail's quiet-session
  // timeout. Falls back to the turn's own start: a round that has produced no
  // body items yet still had activity when the user sent it.
  const tailTurnLastActivityAtMs = useMemo(() => {
    const tail = groupMeta[groupMeta.length - 1];
    return tail?.endMs ?? tail?.startMs ?? null;
  }, [groupMeta]);

  const renderGroupHeader = useGroupHeaderRenderer({
    displaySourceGroupIndices,
    sourceGroupCount: groupCounts.length,
    displayGroupHeaders,
    displayGroupMeta,
    displayGroupCount: displayGroupCounts.length,
    collapseLabelVariant: groupChatEnabled ? "agents" : "agent",
    turnPaginationEnabled,
    tailTurnPhase,
    hideUserMessage: hideGroupUserMessage,
    defaultTurnCollapsed,
    turnCollapseInteractionAtRef,
    onEditSubmit: mutationActionsDisabled ? undefined : handleEditUserMessage,
    onRestoreCheckpoint: mutationActionsDisabled
      ? undefined
      : handleHeaderRestoreCheckpoint,
  });
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
  const conversationMinimapOpen =
    !turnPaginationEnabled && !turnPageListOpen && !agentOrgOverviewOpen;
  // The scrollport reserves nothing for the minimap rail. While the rail has
  // no space of its own it floats as an inset pill over the transcript, and
  // it only goes flush against the edge once the pane is wide enough that it
  // covers nothing (see `ConversationMinimap`'s placement classes).
  const showTurnContextRow =
    turnPaginationEnabled ||
    Boolean(agentOrgCurrentMemberName) ||
    Boolean(agentOrgOverviewPanel);
  const transcriptTopPaddingPx = resolveTranscriptTopPaddingPx(
    chromeTopInset,
    turnPaginationEnabled || groupChatViewActive
  );
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
      tailTurnPhase={tailTurnPhase}
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
  const pinnedChromeLayer = (
    <>
      {search.isSearchVisible ? (
        <div
          className={`flex-shrink-0 border-b border-border-2 ${surfaceBgClass}`}
          data-chat-search-chrome
        >
          <div
            className={`mx-auto w-full ${CHAT_PANEL_WIDTH_TOKENS.contentMaxWidth}`}
          >
            <ChatSearchBar search={search} />
          </div>
        </div>
      ) : null}
      {pinnedHeaderLayer}
    </>
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
        <div className={CHAT_PANEL_WIDTH_TOKENS.contentWidth}>
          <SessionHeader sessionInfo={sessionInfo} />
        </div>

        {pinnedHeaderPortalHost
          ? createPortal(
              <div
                className="chat-history-portal"
                style={chatHistoryContainerStyle}
              >
                {pinnedChromeLayer}
              </div>,
              pinnedHeaderPortalHost
            )
          : pinnedChromeLayer}

        {/* Anchor cloud-download progress to the chat-pane header edge instead
            of the virtualized body below SessionHeader. Transcript items and
            pinned headers create local z-layers up to 70, so this status-only
            layer sits above chat content but below app modals (z-10000+). */}
        {hasCloudDownloadProgress && activeProjectionHistory.length > 0 && (
          <div
            className={`pointer-events-none absolute left-0 right-0 top-0 z-[9999] mx-auto p-2 ${CHAT_PANEL_WIDTH_TOKENS.contentMaxWidth}`}
          >
            <CloudSessionDownloadProgressCard sessionId={activeId} />
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          {agentOrgOverviewOpen && agentOrgOverviewPanel && (
            <div
              className={`max-h-[45%] flex-shrink-0 overflow-y-auto scrollbar-hide ${surfaceBgClass}`}
            >
              <div
                className={`mx-auto w-full px-2 pb-2 ${CHAT_PANEL_WIDTH_TOKENS.contentMaxWidth}`}
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
            {conversationMinimapOpen && (
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
                className={`pointer-events-none absolute left-0 right-0 top-0 z-[9999] mx-auto p-2 ${CHAT_PANEL_WIDTH_TOKENS.contentMaxWidth}`}
              >
                <div className={`pointer-events-auto ${surfaceBgClass}`}>
                  <ChatLoadingBlock />
                </div>
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
                      tailTurnStartedAtMs={tailTurnStartedAtMs}
                      tailTurnLastActivityAtMs={tailTurnLastActivityAtMs}
                      flatItems={displayFlatItems}
                      groupCounts={displayGroupCounts}
                      turnIds={displayTurnIds}
                      assistantCopyEventIdsByGroup={
                        assistantCopyEventIdsByGroup
                      }
                      resolveAssistantTurnCopyContent={
                        resolveAssistantTurnCopyContent
                      }
                      totalFlatItems={displayTotalFlatItems}
                      lastAssistantFlatIndexPerItem={
                        displayLastAssistantFlatIndexPerItem
                      }
                      codeBlockContainerWidth={codeBlockContainerWidth ?? 0}
                      footerSpacerHeight={footerSpacerHeight}
                      bottomInset={bottomInset}
                      topPaddingPx={transcriptTopPaddingPx}
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
                    sessionId={activeId}
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
