import { useAtomValue } from "jotai";
import React from "react";

import { useCurrentTurnLastAgentMessage } from "@src/engines/Simulator/hooks/useCurrentTurnLastAgentMessage";
import { useWorkStationPanels } from "@src/hooks/workStation";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import { workstationActiveSessionIdAtom } from "@src/store/session";
import { simulatorCaptionBarEnabledAtom } from "@src/store/ui/simulatorAtom";
import {
  workStationFollowAgentHighlightEnabledAtom,
  workStationPrimarySidebarCollapsedAtom,
  workStationStatusBarHiddenAtom,
  workStationTitleBarHiddenAtom,
} from "@src/store/ui/workStationAtom";
import { activeWorkStationTabAtom } from "@src/store/workstation/tabs";

import { StatusBarRenderer } from "../shared/StatusBar/StatusBarRenderer";
import { WorkspacePortScanner } from "../shared/StatusBar/WorkspacePortScanner";
import { useWorkspacePortAdvertisedUrls } from "../shared/StatusBar/utils/useWorkspacePortAdvertisedUrls";
import AgentStationChromeFrame from "./AgentStationChromeFrame";
import AgentStationTopHeader from "./AgentStationTopHeader";
import { AppShellContent } from "./AppShellContent";
import WorkstationTabBar from "./WorkstationTabBar";
import WorkstationTabHeader from "./WorkstationTabHeader";
import { useAppShellActions } from "./hooks/useAppShellActions";
import { useAppShellDerivedState } from "./hooks/useAppShellDerivedState";
import { useAppShellDock } from "./hooks/useAppShellDock";
import { useAppShellRepo } from "./hooks/useAppShellRepo";
import { useAppShellRouteSync } from "./hooks/useAppShellRouteSync";
import { useAppShellSimulatorPanelSync } from "./hooks/useAppShellSimulatorPanelSync";
import { useAppShellStationMode } from "./hooks/useAppShellStationMode";
import { useAppShellStatusBar } from "./hooks/useAppShellStatusBar";
import { useLaunchpadTab } from "./hooks/useLaunchpadTab";
import { useTerminalTabTeardown } from "./hooks/useTerminalTabTeardown";

interface AppShellProps {
  /** Whether WorkStation is currently visible (code view mode is active) */
  isActive?: boolean;
  /** Whether the chat panel is taking over the WorkStation surface */
  chatPanelFocused?: boolean;
}

const AppShell = React.memo(
  ({ isActive = true, chatPanelFocused = false }: AppShellProps) => {
    const _titleBarHidden = useAtomValue(workStationTitleBarHiddenAtom);
    const statusBarHidden = useAtomValue(workStationStatusBarHiddenAtom);
    const followAgentHighlightEnabled = useAtomValue(
      workStationFollowAgentHighlightEnabledAtom
    );
    const primaryPanelCollapsed = useAtomValue(
      workStationPrimarySidebarCollapsedAtom
    );
    const captionEnabled = useAtomValue(simulatorCaptionBarEnabledAtom);
    const captionMessage = useCurrentTurnLastAgentMessage();
    const workstationActiveSessionId = useAtomValue(
      workstationActiveSessionIdAtom
    );
    const activeWorkStationTab = useAtomValue(activeWorkStationTabAtom);
    const { repoPath, repoName, pathExists, lastSeenPath } = useAppShellRepo();
    const { visitedModes } = useAppShellDock();
    // Called for its side effects on the workstation base path (station mode /
    // chat visibility / chat width); the content host follows the active tab.
    useAppShellRouteSync();

    const {
      isAgentStation,
      hasVisitedAgentStation,
      illuminateAgentStationChrome,
    } = useAppShellStationMode({ followAgentHighlightEnabled });

    const agentStationCaptionVisible =
      isAgentStation &&
      captionEnabled &&
      !!captionMessage &&
      !!workstationActiveSessionId;

    // Keep a Launchpad tab as the pool's home base: seed it when empty, drop
    // it once real tabs exist (regular WorkStation only — Agent Station has
    // its own surface).
    useLaunchpadTab(!isAgentStation);

    // Closing the Terminal tab kills all running PTYs (VS Code-style).
    useTerminalTabTeardown();

    const workStationPanels = useWorkStationPanels();
    useAppShellSimulatorPanelSync({ isAgentStation, workStationPanels });

    const { handleSelectRepo, handleOpenSettings } = useAppShellActions();

    const {
      activeHost,
      isCodeMode,
      isBrowserMode,
      isProjectMode,
      codeContentVisible,
      browserContentVisible,
      projectContentVisible,
    } = useAppShellDerivedState();

    const hasVisitedCode = visitedModes.has("code");
    const hasVisitedBrowser = visitedModes.has("browser");
    const hasVisitedProject = visitedModes.has("project");

    const showCodeEditorBottomPanelToggle =
      codeContentVisible &&
      !isAgentStation &&
      activeWorkStationTab?.type !== "source-control";
    const showSettingsButton =
      (codeContentVisible || projectContentVisible) && !isAgentStation;

    useAppShellStatusBar({
      primaryPanelCollapsed,
      showSettingsButton,
      showCodeEditorBottomPanelToggle,
      handleOpenSettings,
      workStationPanels,
    });

    const portsEnabled = isCodeMode && isActive && !isAgentStation;
    useWorkspacePortAdvertisedUrls(portsEnabled);

    const showStatusBar = !statusBarHidden && !isAgentStation;
    return (
      <div className="group relative flex h-full w-full min-w-0 flex-col overflow-hidden bg-workstation-bg">
        {isAgentStation && <AgentStationTopHeader />}
        <AgentStationChromeFrame
          enabled={followAgentHighlightEnabled && isAgentStation}
          illuminated={illuminateAgentStationChrome}
          captionVisible={agentStationCaptionVisible}
          hasSession={!!workstationActiveSessionId}
        >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {!isAgentStation && (
              <div data-guide-target={GUIDE_TARGETS.WORKSTATION_TAB_BAR}>
                <WorkstationTabBar host={activeHost} />
              </div>
            )}
            {!isAgentStation && (
              <div data-guide-target={GUIDE_TARGETS.WORKSTATION_TAB_HEADER}>
                <WorkstationTabHeader />
              </div>
            )}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <AppShellContent
                repoPath={repoPath}
                repoName={repoName}
                pathExists={pathExists}
                lastSeenPath={lastSeenPath}
                isActive={isActive}
                chatPanelFocused={chatPanelFocused}
                isAgentStation={isAgentStation}
                hasVisitedAgentStation={hasVisitedAgentStation}
                hasVisitedCode={hasVisitedCode}
                hasVisitedBrowser={hasVisitedBrowser}
                hasVisitedProject={hasVisitedProject}
                isCodeMode={isCodeMode}
                isBrowserMode={isBrowserMode}
                isProjectMode={isProjectMode}
                codeContentVisible={codeContentVisible}
                browserContentVisible={browserContentVisible}
                projectContentVisible={projectContentVisible}
                handleSelectRepo={handleSelectRepo}
              />
            </div>
          </div>
          {portsEnabled && <WorkspacePortScanner enabled />}
          {showStatusBar && <StatusBarRenderer />}
        </AgentStationChromeFrame>
      </div>
    );
  }
);

AppShell.displayName = "AppShell";

export default AppShell;
