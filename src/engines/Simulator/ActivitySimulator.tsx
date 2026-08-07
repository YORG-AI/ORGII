/**
 * ActivitySimulator Page
 *
 * All atom reads live here (mirroring the original structure exactly).
 * Heavy per-domain logic is delegated to:
 *   useSimulatorSession      — session identity, events, thread management
 *   useSimulatorDisplayState — pure derived values (displayEvent, dock, layout)
 *   useSimulatorSubagents    — child session detection, dock-app state
 *
 * JSX responsibilities:
 *   - Split view (main grid top + subagent banner bottom) when subagents exist
 *   - Dock chrome (MusicPlayerReplayBar + DockReplayControl)
 *   - Floating chat input overlay
 *   - Dock context menu
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { RecentFilesProvider } from "@src/contexts/session";
import { replayModeAtom } from "@src/engines/SessionCore";
import type { ReplayMode } from "@src/engines/SessionCore/core/types";
import { chatVisibleAtom } from "@src/store/ui/chatPanelAtom";
import {
  bumpSimulatorDiffRefreshNonceAtom,
  simulatorAutoLayoutAtom,
  simulatorDiffScopeRequestAtom,
  simulatorEffectiveDockAppAtom,
  simulatorFollowAppLockAtom,
  simulatorInlineChatInputCollapsedAtom,
  simulatorLayoutAtom,
  simulatorMiniCPMStepExplanationVisibleAtom,
  simulatorSelectedAppAtom,
  simulatorShowDockAtom,
} from "@src/store/ui/simulatorAtom";
import { workStationLayoutModeAtom } from "@src/store/ui/workStationAtom";

import ActivitySimulatorGrid from "./ActivitySimulatorGrid";
import {
  type DockApp,
  DockContextMenu,
  DockReplayControl,
  StationDockChrome,
  getAppById,
} from "./components/Dock";
import MiniCPMStepExplanationPanel from "./components/MiniCPMStepExplanationPanel";
import MusicPlayerReplayBar from "./components/MusicPlayerReplayBar";
import SimulatorFloatingInput from "./components/SimulatorFloatingInput";
import { SubagentPipCard } from "./components/SubagentPipCard";
import { useSimulatorDisplayState } from "./hooks/useSimulatorDisplayState";
import { useSimulatorSession } from "./hooks/useSimulatorSession";
import { useSimulatorSubagents } from "./hooks/useSimulatorSubagents";
import { AppType } from "./types/appTypes";

const ActivitySimulator: React.FC = memo(() => {
  const { t } = useTranslation("sessions");
  // ── Atoms (same set as original ActivitySimulator) ─────────────────────
  const manualLayout = useAtomValue(simulatorLayoutAtom);
  const autoLayoutEnabled = useAtomValue(simulatorAutoLayoutAtom);
  const showDock = useAtomValue(simulatorShowDockAtom);
  const workStationLayoutMode = useAtomValue(workStationLayoutModeAtom);
  const chatVisible = useAtomValue(chatVisibleAtom);
  const simulatorInputCollapsed = useAtomValue(
    simulatorInlineChatInputCollapsedAtom
  );
  const [showMiniCPMStepExplanation, setShowMiniCPMStepExplanation] = useAtom(
    simulatorMiniCPMStepExplanationVisibleAtom
  );
  const [selectedApp, setSelectedApp] = useAtom(simulatorSelectedAppAtom);
  const replayMode = useAtomValue(replayModeAtom);
  const setReplayMode = useSetAtom(replayModeAtom) as (
    mode: ReplayMode
  ) => void;
  const setEffectiveDockApp = useSetAtom(simulatorEffectiveDockAppAtom);
  const followAppLock = useAtomValue(simulatorFollowAppLockAtom);
  const setDiffScope = useSetAtom(simulatorDiffScopeRequestAtom);
  const refreshDiff = useSetAtom(bumpSimulatorDiffRefreshNonceAtom);

  const floatingDockComposerAlignClass =
    workStationLayoutMode === "left" ? "items-end" : "items-start";

  // ── Core session state ─────────────────────────────────────────────────
  const {
    sessionId,
    hasSession,
    eventIds,
    eventById,
    previewById,
    specs,
    filteredEvents,
    allEvents,
    currentEvent,
    currentEventIndex,
    eventStoreVersion,
    mainCursorMs,
    selectedTaskId,
    executionThreads,
    executionThreadCount,
  } = useSimulatorSession();

  // ── Pure derived display state ─────────────────────────────────────────
  const {
    effectiveSelectedApp,
    displayEvent,
    dockActiveApp,
    currentWorkingApp,
    layout,
  } = useSimulatorDisplayState({
    selectedApp,
    followAppLock,
    eventIds,
    eventById,
    previewById,
    filteredEvents,
    currentEvent,
    currentEventIndex,
    selectedTaskId,
    executionThreadCount,
    executionThreads,
    replayMode,
    autoLayoutEnabled,
    manualLayout,
  });

  // Sync effective dock app to atom for app mode controls.
  useEffect(() => {
    setEffectiveDockApp(dockActiveApp);
  }, [dockActiveApp, setEffectiveDockApp]);

  // ── Subagent split pane ────────────────────────────────────────────────
  const { activeSubagents, hasActiveSubagents } = useSimulatorSubagents({
    sessionId,
    eventStoreVersion,
    currentEvent,
    allEvents,
  });

  // When subagents are active the layout automatically becomes a split view
  // (main agent top, subagent banner bottom). No dock switch or pip toggle
  // is needed — presence of subagents is the only condition.
  const prevHasSubagentsRef = useRef(hasActiveSubagents);
  useEffect(() => {
    const wasActive = prevHasSubagentsRef.current;
    prevHasSubagentsRef.current = hasActiveSubagents;

    // When subagents disappear and the dock is stuck on BACKGROUND_TASKS,
    // reset it so the main grid takes over.
    if (
      wasActive &&
      !hasActiveSubagents &&
      selectedApp === AppType.BACKGROUND_TASKS
    ) {
      setSelectedApp(null);
    }
  }, [hasActiveSubagents, selectedApp, setSelectedApp]);

  // ── Dock context menu ──────────────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    position: { x: number; y: number };
    targetApp: DockApp | null;
  }>({
    visible: false,
    position: { x: 0, y: 0 },
    targetApp: null,
  });

  const handleDockAppClick = useCallback(
    (appId: string, _event?: React.MouseEvent) => {
      // Clicking the dock = user wants to drive selectedApp manually,
      // which conflicts with follow mode's "agent decides the selected
      // app" semantics. Drop to replay so the user's pick sticks. Event
      // tab clicks already exit follow via navigateToEventAndUpdateBar.
      if (replayMode === "follow") {
        setReplayMode("replay");
      }
      // Manually opening the Diff app from the dock is the "whole-session
      // diff" entry point — clear any per-round scope left over from a chat
      // `TurnMetadataFooter` "Review" click (which only the composer files-pill
      // otherwise clears) and refresh so the full view reflects the latest
      // working tree without re-applying a stale file-focus request.
      if ((appId as AppType) === AppType.DIFF) {
        setDiffScope(null);
        refreshDiff();
      }
      setSelectedApp(appId as AppType);
    },
    [replayMode, setReplayMode, setSelectedApp, setDiffScope, refreshDiff]
  );

  const handleDockAppContextMenu = useCallback(
    (appId: string, event: React.MouseEvent) => {
      const app = getAppById(appId);
      if (app) {
        setContextMenu({
          visible: true,
          position: { x: event.clientX, y: event.clientY },
          targetApp: app,
        });
      }
    },
    []
  );

  const handleSwitchTo = useCallback(
    (appId: string) => {
      handleDockAppClick(appId);
      setContextMenu((prev) => ({ ...prev, visible: false }));
    },
    [handleDockAppClick]
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────
  const gridProps = {
    layout,
    currentEvent: displayEvent,
    events: filteredEvents,
    specs,
    forceAppType: effectiveSelectedApp,
    taskThreads: selectedTaskId ? [] : executionThreads,
    selectedThreadId: selectedTaskId,
  };

  // In the split-view the main grid must not be forced to BACKGROUND_TASKS.
  // BACKGROUND_TASKS has no visual content of its own — forcing it makes the
  // grid blank.  When it is selected we also have to replace displayEvent with
  // the raw currentEvent because useSimulatorDisplayState returns null for
  // displayEvent when selectedApp=BACKGROUND_TASKS (no matching events exist).
  // taskThreads is also neutralized: the PIP bottom strip already renders one
  // cell per subagent, so letting the TOP pane enter multi-task grid mode
  // duplicates the same monitoring row twice (stacked "two rows" look).
  const isBgTasksSelected = effectiveSelectedApp === AppType.BACKGROUND_TASKS;
  const splitGridProps = {
    ...gridProps,
    forceAppType: isBgTasksSelected ? null : effectiveSelectedApp,
    currentEvent: isBgTasksSelected ? currentEvent : displayEvent,
    taskThreads: [],
  };
  const showFloatingInputOverlay =
    showDock && !chatVisible && hasSession && !simulatorInputCollapsed;
  const showReplayBar =
    showDock &&
    Boolean(sessionId) &&
    replayMode !== "follow" &&
    dockActiveApp !== AppType.DIFF;

  if (!hasSession) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--cm-editor-background)] p-4">
        <span className="text-sm text-text-3">
          {t("simulator.noActiveSession")}
        </span>
      </div>
    );
  }

  return (
    <RecentFilesProvider maxFiles={5}>
      <div className="wp__sync__operation__container flex h-full w-full min-w-0 flex-col">
        <div className="tab-content relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="flex h-full w-full flex-col overflow-hidden">
            <div className="relative flex min-h-0 flex-1 flex-row overflow-hidden">
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                {hasActiveSubagents ? (
                  /* Split view: main agent (top) + subagent banner (bottom) */
                  <SubagentPipCard
                    mainContent={<ActivitySimulatorGrid {...splitGridProps} />}
                    activeSessions={activeSubagents}
                    mainCursorMs={mainCursorMs}
                    liveFollow={replayMode === "follow"}
                  />
                ) : (
                  <ActivitySimulatorGrid {...gridProps} />
                )}

                {showFloatingInputOverlay && (
                  <div
                    className={`pointer-events-none absolute inset-0 z-[25] flex flex-col justify-end p-3 sm:p-4 ${floatingDockComposerAlignClass}`}
                  >
                    <SimulatorFloatingInput />
                  </div>
                )}

                {showReplayBar && showMiniCPMStepExplanation && (
                  <div className="pointer-events-none absolute bottom-16 left-3 right-3 z-[26] flex justify-center sm:left-6 sm:right-6">
                    <MiniCPMStepExplanationPanel
                      onClose={() => setShowMiniCPMStepExplanation(false)}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* ── Dock (replay bar + app icons) ── */}
            {showDock && (
              <div className="flex shrink-0 flex-col overflow-visible">
                {showReplayBar && (
                  <div className="overflow-visible border-t border-border-2">
                    <MusicPlayerReplayBar />
                  </div>
                )}
                <StationDockChrome autoHide={false}>
                  <DockReplayControl
                    activeApp={dockActiveApp}
                    currentWorkingApp={currentWorkingApp}
                    showDock={showDock}
                    onAppClick={handleDockAppClick}
                    onAppContextMenu={handleDockAppContextMenu}
                  />
                </StationDockChrome>
              </div>
            )}
          </div>
        </div>

        <DockContextMenu
          visible={contextMenu.visible}
          position={contextMenu.position}
          targetApp={contextMenu.targetApp}
          activeAppType={dockActiveApp ?? undefined}
          onSwitchTo={handleSwitchTo}
          onClose={closeContextMenu}
        />
      </div>
    </RecentFilesProvider>
  );
});

ActivitySimulator.displayName = "ActivitySimulator";
export default ActivitySimulator;
