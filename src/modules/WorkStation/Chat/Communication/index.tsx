/**
 * SessionReplayMessages Component
 *
 * Communication replay interface for messages, interaction, preview, and todo events.
 *
 * Uses WorkStationShell for consistent layout.
 * Structure:
 * - Right: ReplayTabBar (Messages / Kanban / Interactions / Preview) + stacked event viewer
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, {
  Suspense,
  lazy,
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { EDITOR_TAB_CANVAS_BG_CLASS } from "@src/config/workstation/tokens";
import { useAgentOrgRunView } from "@src/engines/ChatPanel/InputArea/components/useAgentOrgRunView";
import EventWrapper from "@src/engines/ChatPanel/adapters/EventWrapper";
import { InSimulatorReplayContext } from "@src/engines/ChatPanel/blocks/primitives/inSimulatorReplayContext";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  getPlanEventAliases,
  isPlanDisplayEvent,
  planAliasesContain,
} from "@src/engines/SessionCore/derived/planDisplayEvents";
import type { SimulatorAppBaseState } from "@src/engines/Simulator/apps/core/types";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import { matchesCanvasEvent } from "@src/modules/WorkStation/Canvas/config";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import {
  TextSelectionDropdown,
  useTextSelectionDropdown,
} from "@src/scaffold/ContextMenu/exports";
import {
  chatCodeFontSizeAtom,
  chatFontSizeAtom,
  chatLineHeightAtom,
} from "@src/store/config/configAtom";
import { canvasPreviewAtom } from "@src/store/session/canvasPreviewAtom";
import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";
import { simulatorEffectiveDockAppAtom } from "@src/store/ui/simulatorAtom";
import type { BackendEvent } from "@src/types/session/steps";
import { openFileInWorkStation } from "@src/util/ui/openFileInWorkStation";

import {
  FileHeader,
  SimulatorReplayChrome,
  WorkStationShell,
  buildPrimarySidebarConfig,
} from "../../shared";
import MessageViewer from "./MessageViewer";
import PlanApprovalActions from "./PlanApprovalActions";
import {
  type PlanIntentOverride,
  computeEffectivePlanPreview,
  computeEffectivePlanView,
} from "./planPreviewView";
import type { MessageViewMode } from "./types";
import { useMessages } from "./useMessages";
import { usePlanApproval } from "./usePlanApproval";
import { useReplayTabs } from "./useReplayTabs";

const LazySimulatorCanvas = lazy(
  () => import("@src/modules/WorkStation/Canvas")
);

const HIDDEN_PRIMARY_SIDEBAR_CONFIG = buildPrimarySidebarConfig({
  content: null,
  collapsed: true,
  size: 0,
});

export interface SimulatorMessagesProps {
  currentEvent?: unknown;
  mode?: "interactive" | "simulation";
  customControls?: React.ReactNode;
  /** Explicit session ID — preferred over sessionIdAtom for WorkStation contexts
   *  where the global atom may not reflect the currently rendered SDE session. */
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
  const selectionContainerRef = useRef<HTMLDivElement>(null);
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

  const previewMessages = useMemo(
    () =>
      interactionMessages.filter((message) =>
        isPlanDisplayEvent(message.event)
      ),
    [interactionMessages]
  );

  const transcriptMessages = useMemo(() => {
    const combined = [
      ...chatMessages,
      ...state.thinkMessages,
      ...state.todoMessages,
      ...interactionMessages,
    ];
    combined.sort((messageA, messageB) => {
      const timestampDelta =
        new Date(messageA.timestamp).getTime() -
        new Date(messageB.timestamp).getTime();
      return timestampDelta || messageA.order - messageB.order;
    });
    return combined;
  }, [
    chatMessages,
    state.thinkMessages,
    state.todoMessages,
    interactionMessages,
  ]);

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

  const handleOpenPlanInMyStation = useCallback(() => {
    if (planPath) openFileInWorkStation(planPath, { defaultPreviewMode: true });
  }, [planPath]);

  // Plan-scoped user intent. When the user explicitly picks a replay view or
  // flips the source/preview toggle while a plan is pending, we tag that choice
  // with the plan's id in a single intent object. The effective values below
  // honour the intent only while that same plan stays pending — replacing the
  // old auto-open Effect + dedup-ref with a pure render-time derivation.
  const [planIntentOverride, setPlanIntentOverride] =
    useState<PlanIntentOverride | null>(null);

  const currentPlanId = pendingPlanId;
  const effectiveViewMode = computeEffectivePlanView({
    baseView: viewMode,
    currentPlanId,
    override: planIntentOverride,
  });
  const effectivePreviewMode = computeEffectivePlanPreview({
    currentPlanId,
    override: planIntentOverride,
  });

  // Merge a partial choice into the existing intent when it targets the same
  // plan (so setting the view never clobbers a prior preview choice, and vice
  // versa); otherwise start a fresh intent for the current plan.
  const recordPlanIntent = useCallback(
    (patch: { view?: MessageViewMode; preview?: boolean }) => {
      if (!currentPlanId) return;
      setPlanIntentOverride((prev) =>
        prev && prev.planId === currentPlanId
          ? { ...prev, ...patch }
          : { planId: currentPlanId, ...patch }
      );
    },
    [currentPlanId]
  );

  const handleViewModeChange = useCallback(
    (nextView: MessageViewMode) => {
      setViewMode(nextView);
      recordPlanIntent({ view: nextView });
    },
    [setViewMode, recordPlanIntent]
  );

  const handlePreviewToggle = useCallback(
    (nextPreview: boolean) => {
      recordPlanIntent({ preview: nextPreview });
    },
    [recordPlanIntent]
  );

  const currentMessages =
    effectiveViewMode === "chat"
      ? transcriptMessages
      : effectiveViewMode === "todo"
        ? state.todoMessages
        : effectiveViewMode === "think"
          ? state.thinkMessages
          : effectiveViewMode === "preview"
            ? previewMessages
            : interactionMessages;
  const selectedMessageIsPlan = Boolean(
    state.selectedMessage?.event &&
    isPlanDisplayEvent(state.selectedMessage.event)
  );

  const { replayTabs, activeTabId, handleTabClick } = useReplayTabs({
    viewMode: effectiveViewMode,
    setViewMode: handleViewModeChange,
  });

  const headerBreadcrumbLabel = useMemo(() => {
    if (effectiveViewMode === "todo") {
      return t("simulator.replay.channelsSidebar.kanban");
    }
    if (effectiveViewMode === "interaction") {
      return t("simulator.replay.channelsSidebar.interactions");
    }
    if (effectiveViewMode === "preview") {
      return t("common:common.preview");
    }
    return t("simulator.replay.channelsSidebar.messages");
  }, [t, effectiveViewMode]);

  const headerFilePath = headerBreadcrumbLabel;
  const sessionEvent = currentEvent as SessionEvent | undefined;
  const currentFunctionName = sessionEvent?.functionName ?? "";
  const isCanvasEvent = matchesCanvasEvent(currentFunctionName);

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

  const {
    visible: selectionDropdownVisible,
    position: selectionDropdownPosition,
    selectedText,
    hideDropdown: hideSelectionDropdown,
  } = useTextSelectionDropdown({
    source: "terminal",
    containerRef: selectionContainerRef,
    onAddToContext: handleSelectedTextAddToChat,
    enabled: mode === "simulation" && !isCanvasEvent,
  });

  const handleMessageClick = useCallback(
    (messageId: string) => {
      jumpToMessage(messageId);
      if (
        previewMessages.some((message) =>
          planAliasesContain(getPlanEventAliases(message.event), messageId)
        )
      ) {
        handleViewModeChange("preview");
      }
    },
    [jumpToMessage, previewMessages, handleViewModeChange]
  );

  // Entering edit forces the preview surface so the plan textarea is actually
  // rendered (the plan doc only mounts in "preview" view).
  const handlePlanEditToggle = useCallback(() => {
    if (!isEditing) handleViewModeChange("preview");
    handleEditToggle();
  }, [isEditing, handleViewModeChange, handleEditToggle]);

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

  const atomSessionId = useAtomValue(sessionIdAtom);
  // Prefer the explicitly passed sessionId (WorkStation Build context) over the
  // global atom, which may lag or point to a different surface's active session.
  const sessionId = propSessionId ?? atomSessionId;

  const canvasPreview = useAtomValue(canvasPreviewAtom);
  const activeCanvasPayload =
    canvasPreview?.sessionId === sessionId ? canvasPreview.payload : null;

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

  const noopSelectItem = useCallback((_itemId: string) => {}, []);

  // Handle canvas events (early return AFTER all hooks)
  if (isCanvasEvent) {
    return (
      <EventWrapper
        event={currentEvent as unknown as BackendEvent}
        mode={mode}
        expand={true}
        padding="p-0"
      >
        <Suspense
          fallback={
            <Placeholder
              variant="loading"
              placement="detail-panel"
              fillParentHeight
              title="Loading…"
            />
          }
        >
          <LazySimulatorCanvas
            state={{} as SimulatorAppBaseState}
            selectedItemId={null}
            onSelectItem={noopSelectItem}
            currentEvent={currentEvent}
            mode={mode}
          />
        </Suspense>
      </EventWrapper>
    );
  }

  const mainContent = (
    <InSimulatorReplayContext.Provider value={true}>
      <div
        ref={selectionContainerRef}
        className="flex h-full w-full flex-col overflow-hidden"
        style={
          {
            fontSize: `${chatFontSize}px`,
            lineHeight: chatLineHeight ?? 1.6,
            "--chat-font-size": `${chatFontSize}px`,
            "--chat-code-font-size": `${chatCodeFontSize ?? 13}px`,
            "--chat-line-height": chatLineHeight ?? 1.6,
          } as React.CSSProperties
        }
      >
        <MessageViewer
          messages={currentMessages}
          viewMode={effectiveViewMode}
          setViewMode={handleViewModeChange}
          orgMembers={orgMembers}
          sessionReplayMode={mode}
          planPreviewMode={isPlanDoc ? effectivePreviewMode : undefined}
          planEditState={
            isPlanDoc && isPlanPending && isEditing
              ? { value: editedContent, onChange: setEditedContent }
              : undefined
          }
          planDocPending={isPlanDoc && isPlanPending}
          activePlanMessage={activePlanMessage}
          selectedMessage={state.selectedMessage}
          previewSelectedPlan={
            effectiveViewMode === "preview" &&
            (hasLocalSelection || selectedMessageIsPlan)
          }
          onMessageClick={handleMessageClick}
          currentEventId={state.currentEventId}
          canvasPayload={activeCanvasPayload}
        />
      </div>
    </InSimulatorReplayContext.Provider>
  );

  return (
    <EventWrapper
      event={currentEvent as unknown as BackendEvent}
      mode={mode}
      expand={true}
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
          filePath={headerFilePath}
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
              ? () => handlePreviewToggle(!effectivePreviewMode)
              : undefined
          }
          extraActions={planHeaderActions}
        />
        <div className="flex min-h-0 flex-1">
          <WorkStationShell
            primarySidebarConfig={HIDDEN_PRIMARY_SIDEBAR_CONFIG}
            content={mainContent}
            statusBar={null}
            appClassName="session-replay-messages"
          />
        </div>
        <TextSelectionDropdown
          visible={selectionDropdownVisible}
          position={selectionDropdownPosition}
          selectedText={selectedText}
          source="terminal"
          onClose={hideSelectionDropdown}
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
