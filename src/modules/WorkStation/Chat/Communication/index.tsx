import { useAtomValue, useSetAtom } from "jotai";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { EDITOR_TAB_CANVAS_BG_CLASS } from "@src/config/workstation/tokens";
import { useAgentOrgRunView } from "@src/engines/ChatPanel/InputArea/components/useAgentOrgRunView";
import EventWrapper from "@src/engines/ChatPanel/adapters/EventWrapper";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  getPlanEventAliases,
  isPlanDisplayEvent,
  planAliasesContain,
} from "@src/engines/SessionCore/derived/planDisplayEvents";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import { matchesCanvasEvent } from "@src/modules/WorkStation/Canvas/config";
import { SessionJourneyControls } from "@src/modules/WorkStation/Chat/Journey/SessionJourneyControls";
import {
  type JourneyMessageJump,
  listenForJourneyMessageJump,
} from "@src/modules/WorkStation/Chat/Journey/journeyMessageJump";
import {
  TextSelectionDropdown,
  useTextSelectionDropdown,
} from "@src/scaffold/ContextMenu/exports";
import {
  chatCodeFontSizeAtom,
  chatFontSizeAtom,
  chatLineHeightAtom,
} from "@src/store/config/configAtom";
import { openSessionAtom } from "@src/store/session";
import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";
import { simulatorEffectiveDockAppAtom } from "@src/store/ui/simulatorAtom";
import type { BackendEvent } from "@src/types/session/steps";
import { openFileInWorkStation } from "@src/util/ui/openFileInWorkStation";

import {
  FileHeader,
  SimulatorReplayChrome,
  WorkStationShell,
  buildPrimarySidebarConfig,
  buildSecondaryPanelConfig,
} from "../../shared";
import PlanApprovalActions from "./PlanApprovalActions";
import { CommunicationCanvas } from "./components/CommunicationCanvas";
import { CommunicationMessageContent } from "./components/CommunicationMessageContent";
import { usePlanReplayIntent } from "./hooks/usePlanReplayIntent";
import {
  buildCommunicationMessageViewModel,
  selectCommunicationMessages,
} from "./messageViewModel";
import { useMessages } from "./useMessages";
import { usePlanApproval } from "./usePlanApproval";
import { useReplayTabs } from "./useReplayTabs";

const HIDDEN_PRIMARY_SIDEBAR_CONFIG = buildPrimarySidebarConfig({
  content: null,
  collapsed: true,
  size: 0,
});

export interface SimulatorMessagesProps {
  currentEvent?: unknown;
  mode?: "interactive" | "simulation";
  customControls?: React.ReactNode;
  sessionId?: string | null;
}

const SimulatorMessagesComponent: React.FC<SimulatorMessagesProps> = ({
  currentEvent,
  mode = "simulation",
  sessionId: propSessionId,
}) => {
  const { t } = useTranslation("sessions");
  const effectiveDockApp = useAtomValue(simulatorEffectiveDockAppAtom);
  const setAddToAgent = useSetAtom(addToAgentAtom);
  const openSession = useSetAtom(openSessionAtom);
  const selectionContainerRef = useRef<HTMLDivElement>(null);
  const [dockedJourneyReviewPanel, setDockedJourneyReviewPanel] =
    useState<React.ReactNode | null>(null);
  const pendingJourneyJumpRef = useRef<JourneyMessageJump | null>(null);
  const atomSessionId = useAtomValue(sessionIdAtom);
  // Prefer the explicitly passed sessionId (WorkStation Build context) over
  // the global atom, which may lag while a Journey jump changes sessions.
  const sessionId = propSessionId ?? atomSessionId;
  const chatFontSize = useAtomValue(chatFontSizeAtom);
  const chatCodeFontSize = useAtomValue(chatCodeFontSizeAtom);
  const chatLineHeight = useAtomValue(chatLineHeightAtom);

  const {
    viewMode,
    setViewMode,
    chatMessages,
    interactionMessages,
    state,
    hasLocalSelection,
    jumpToMessage,
  } = useMessages();
  const messageViewModel = useMemo(
    () =>
      buildCommunicationMessageViewModel({
        chatMessages,
        thinkMessages: state.thinkMessages,
        todoMessages: state.todoMessages,
        interactionMessages,
      }),
    [chatMessages, interactionMessages, state.thinkMessages, state.todoMessages]
  );

  const {
    activePlanMessage,
    pendingPlanId,
    planPath,
    isPlanDoc,
    isPlanPending,
    isEditing,
    editedContent,
    submitting,
    buildDisabled,
    setEditedContent,
    handleEditToggle,
    handleSave,
  } = usePlanApproval({
    interactionMessages,
    selectedMessage: state.selectedMessage,
    viewMode,
  });
  const {
    effectiveViewMode,
    effectivePreviewMode,
    handleViewModeChange,
    handlePreviewModeChange,
  } = usePlanReplayIntent({
    baseViewMode: viewMode,
    currentPlanId: pendingPlanId,
    setBaseViewMode: setViewMode,
  });
  const currentMessages = selectCommunicationMessages({
    viewMode: effectiveViewMode,
    viewModel: messageViewModel,
    thinkMessages: state.thinkMessages,
    todoMessages: state.todoMessages,
    interactionMessages,
  });
  const selectedMessageIsPlan = Boolean(
    state.selectedMessage?.event &&
    isPlanDisplayEvent(state.selectedMessage.event)
  );

  const { replayTabs, activeTabId, handleTabClick } = useReplayTabs({
    viewMode: effectiveViewMode,
    setViewMode: handleViewModeChange,
  });
  const headerBreadcrumbLabel = useMemo(() => {
    switch (effectiveViewMode) {
      case "todo":
        return t("simulator.replay.channelsSidebar.kanban");
      case "interaction":
        return t("simulator.replay.channelsSidebar.interactions");
      case "preview":
        return t("common:common.preview");
      case "chat":
      case "think":
        return t("simulator.replay.channelsSidebar.messages");
    }
  }, [effectiveViewMode, t]);

  const sessionEvent = currentEvent as SessionEvent | undefined;
  const isCanvasEvent = matchesCanvasEvent(sessionEvent?.functionName ?? "");
  const handleSelectedTextAddToChat = useCallback(
    (text: string, _sessionId: string | null) => {
      setAddToAgent({
        type: "terminal",
        text,
        displayName: headerBreadcrumbLabel,
      });
    },
    [headerBreadcrumbLabel, setAddToAgent]
  );
  const selectionDropdown = useTextSelectionDropdown({
    source: "terminal",
    containerRef: selectionContainerRef,
    onAddToContext: handleSelectedTextAddToChat,
    enabled: mode === "simulation" && !isCanvasEvent,
  });

  const handleMessageClick = useCallback(
    (messageId: string) => {
      jumpToMessage(messageId);
      if (
        messageViewModel.previewMessages.some((message) =>
          planAliasesContain(getPlanEventAliases(message.event), messageId)
        )
      ) {
        handleViewModeChange("preview");
      }
    },
    [handleViewModeChange, jumpToMessage, messageViewModel.previewMessages]
  );
  const handleDockedJourneyReviewPanel = useCallback(
    (panel: React.ReactNode | null) => setDockedJourneyReviewPanel(panel),
    []
  );
  useEffect(
    () =>
      listenForJourneyMessageJump(
        ({ sessionId: targetSessionId, messageId }) => {
          if (targetSessionId !== sessionId) {
            openSession({ sessionId: targetSessionId });
            pendingJourneyJumpRef.current = {
              sessionId: targetSessionId,
              messageId,
            };
            return;
          }
          handleMessageClick(messageId);
        }
      ),
    [handleMessageClick, openSession, sessionId]
  );
  useEffect(() => {
    const pendingJourneyJump = pendingJourneyJumpRef.current;
    if (!pendingJourneyJump || pendingJourneyJump.sessionId !== sessionId)
      return;
    // `jumpToMessage` stores the exact ID. Once the session switch makes its
    // transcript available, MessageViewer expands the window and focuses that
    // row rather than accepting a positional fallback.
    pendingJourneyJumpRef.current = null;
    handleMessageClick(pendingJourneyJump.messageId);
  }, [handleMessageClick, sessionId]);

  // Entering edit forces the preview surface so the plan textarea is actually
  // rendered (the plan doc only mounts in "preview" view).
  const handlePlanEditToggle = useCallback(() => {
    if (!isEditing) handleViewModeChange("preview");
    handleEditToggle();
  }, [handleEditToggle, handleViewModeChange, isEditing]);
  const handleOpenPlanInMyStation = useCallback(() => {
    if (planPath) openFileInWorkStation(planPath, { defaultPreviewMode: true });
  }, [planPath]);
  const planHeaderActions =
    isPlanDoc && isPlanPending ? (
      <div className="flex h-full items-center gap-2">
        <PlanApprovalActions
          isEditing={isEditing}
          submitting={submitting}
          saveDisabled={buildDisabled}
          canOpenInMyStation={Boolean(planPath)}
          onEditToggle={handlePlanEditToggle}
          onSave={handleSave}
          onOpenInMyStation={handleOpenPlanInMyStation}
        />
      </div>
    ) : null;

  // Resolve org-run member info so simulator message bubbles can show the
  // correct sender label (e.g. "Planner updated task" instead of the
  // generic "Agent"). One hook instance per Communication panel — bubbles
  // receive a stable lookup map rather than each calling the hook
  // themselves (which would multiply the 2.5s polling timer).
  const { view: agentOrgRunView } = useAgentOrgRunView(sessionId);
  const orgMembers = useMemo(
    () => agentOrgRunView?.members ?? [],
    [agentOrgRunView]
  );

  if (isCanvasEvent) {
    return <CommunicationCanvas currentEvent={currentEvent} mode={mode} />;
  }

  const messageContent = (
    <CommunicationMessageContent
      containerRef={selectionContainerRef}
      chatFontSize={chatFontSize}
      chatCodeFontSize={chatCodeFontSize}
      chatLineHeight={chatLineHeight}
      viewerProps={{
        messages: currentMessages,
        viewMode: effectiveViewMode,
        setViewMode: handleViewModeChange,
        orgMembers,
        agentOrgTasks: agentOrgRunView?.tasks,
        sessionReplayMode: mode,
        planPreviewMode: isPlanDoc ? effectivePreviewMode : undefined,
        planEditState:
          isPlanDoc && isPlanPending && isEditing
            ? { value: editedContent, onChange: setEditedContent }
            : undefined,
        planDocPending: isPlanDoc && isPlanPending,
        activePlanMessage,
        selectedMessage: state.selectedMessage,
        previewSelectedPlan:
          effectiveViewMode === "preview" &&
          (hasLocalSelection || selectedMessageIsPlan),
        onMessageClick: handleMessageClick,
        currentEventId: state.currentEventId,
      }}
    />
  );

  return (
    <EventWrapper
      event={currentEvent as BackendEvent}
      mode={mode}
      expand
      padding="p-0"
    >
      <SimulatorReplayChrome
        tabs={replayTabs}
        activeEventId={activeTabId}
        onTabClick={handleTabClick}
        sidebarToggleDisabled
        showWorkstationTabHeader={false}
        tabBarSurfaceClassName={EDITOR_TAB_CANVAS_BG_CLASS}
      >
        <FileHeader
          filePath={headerBreadcrumbLabel}
          useFileTypeIcon={false}
          disableNavigation
          plainTitle
          publishToHost="simulator"
          publishEnabled={effectiveDockApp === AppType.CHANNELS}
          isMarkdownFile={isPlanDoc && isPlanPending && !isEditing}
          isPreviewMode={effectivePreviewMode}
          previewSourceLabel={t("common:common.sourceCode")}
          previewLabel={t("common:common.preview")}
          onTogglePreview={
            isPlanDoc && isPlanPending && !isEditing
              ? () => handlePreviewModeChange(!effectivePreviewMode)
              : undefined
          }
          extraActions={
            <>
              {planHeaderActions}
              <SessionJourneyControls
                sessionId={sessionId}
                messageId={state.selectedMessage?.eventId}
                onJumpToMessage={handleMessageClick}
                onDockedReviewPanelChange={handleDockedJourneyReviewPanel}
              />
            </>
          }
        />
        <div className="flex min-h-0 flex-1">
          <WorkStationShell
            primarySidebarConfig={HIDDEN_PRIMARY_SIDEBAR_CONFIG}
            secondaryPanelConfig={
              dockedJourneyReviewPanel
                ? buildSecondaryPanelConfig({
                    content: dockedJourneyReviewPanel,
                    position: "right",
                    size: 320,
                    minSize: 260,
                    maxSize: 480,
                    resetSize: 320,
                    onClose: () => setDockedJourneyReviewPanel(null),
                  })
                : undefined
            }
            content={messageContent}
            statusBar={null}
            appClassName="session-replay-messages"
          />
        </div>
        <TextSelectionDropdown
          visible={selectionDropdown.visible}
          position={selectionDropdown.position}
          selectedText={selectionDropdown.selectedText}
          source="terminal"
          onClose={selectionDropdown.hideDropdown}
          onAddToContext={handleSelectedTextAddToChat}
        />
      </SimulatorReplayChrome>
    </EventWrapper>
  );
};

export const SessionReplayMessages = memo(SimulatorMessagesComponent);
SessionReplayMessages.displayName = "SessionReplayMessages";

export { SessionReplayMessages as SimulatorMessages };
export default SessionReplayMessages;
