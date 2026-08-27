/**
 * EditorBottomPanel Component
 *
 * Bottom panel with tabs: Problems, Output, Terminal, Test Results
 * Handles panel collapse/expand, maximize, and tab switching.
 *
 * ARCHITECTURE (Jan 2026):
 * Follows EditorPrimarySidebar pattern with:
 * - tabs/ folder for tab configuration hooks
 * - content/ folder for tab content components
 * - hooks/ folder for shared panel hooks
 * - components/ folder for shared subcomponents
 *
 * Uses dispatch() for ALL actions (unified with AI):
 * - Panel actions: panel.showBottom, panel.toggleBottom
 * - Terminal actions: terminal.new, terminal.close, terminal.setActive
 *
 * Uses unified Resize system for better performance (0 React render during resize).
 */
// Import from `types`, not the `exports` barrel: the barrel re-exports the
// TerminalCore component and would pull xterm (~330 KB + CSS) into the
// editor shell chunk. Terminal surfaces load it lazily at their mount site.
import {
  type UseTerminalStateReturn,
  getTerminalDisplayTitle,
} from "@/src/engines/TerminalCore/types";
import React, { memo, useCallback, useMemo } from "react";

import { useActionSystem } from "@src/ActionSystem";
import {
  BOTTOM_PANEL_TABS,
  type SecondaryPanelPosition,
} from "@src/store/ui/workStationAtom";

import BottomPanelContent from "./components/BottomPanelContent";
import BottomPanelHeader from "./components/BottomPanelHeader";
import type { OutputChannel } from "./content/OutputContent/types";
import type { Diagnostic } from "./content/ProblemsContent/types";
import { useBottomPanelActions } from "./hooks/useBottomPanelActions";
import { useBottomPanelTabs } from "./hooks/useBottomPanelTabs";
import { useProblemsState } from "./hooks/useProblemsState";
import { useWorkspaceScan } from "./hooks/useWorkspaceScan";
import { useOutputTabConfig } from "./tabs/OutputTab";
import { useProblemsTabConfig } from "./tabs/ProblemsTab";
// Bottom-panel Terminal is intentionally hidden while the standalone Terminal
// tab is the single source of truth (the former `tabs/TerminalTab` was removed).
import { useTestResultsTabConfig } from "./tabs/TestResultsTab";

// ============================================
// Types
// ============================================

export interface EditorBottomPanelProps {
  // Problems
  diagnostics: Diagnostic[];
  onDiagnosticClick: (diagnostic: Diagnostic) => void;
  onClearAllDiagnostics: () => void;
  /** Set diagnostics for a specific file (used by workspace scan) */
  onSetDiagnosticsForFile?: (
    filePath: string,
    diagnostics: Diagnostic[]
  ) => void;

  // Output
  outputChannels: OutputChannel[];
  activeChannelId: string | null;
  onSetActiveChannel: (id: string) => void;
  onClearChannel: (id: string) => void;

  // Terminal
  terminalState: UseTerminalStateReturn;
  onTerminalFileLinkOpen?: (filePath: string, line?: number) => void;
  onKillTerminal: () => void;
  onAddTerminal: (options?: {
    shell?: string;
    args?: string[];
    name?: string;
    profileId?: string;
  }) => void;
  repoPath?: string;

  // Test Results
  onTestResultClick?: (filePath: string, line?: number) => void;

  // Terminal sidebar resize
  terminalSidebarWidth: number;
  onTerminalSidebarWidthChange: (width: number) => void;

  // Panel position (right | bottom) — controlled externally; Shell owns layout
  position?: SecondaryPanelPosition;
  onTogglePosition?: () => void;
}

// ============================================
// Main Component
// ============================================

const EditorBottomPanel: React.FC<EditorBottomPanelProps> = memo(
  ({
    diagnostics,
    onDiagnosticClick,
    onClearAllDiagnostics,
    onSetDiagnosticsForFile,
    outputChannels,
    activeChannelId,
    onSetActiveChannel,
    onClearChannel,
    terminalState,
    onTerminalFileLinkOpen,
    onKillTerminal: _onKillTerminal,
    onAddTerminal: _onAddTerminal,
    repoPath,
    onTestResultClick,
    terminalSidebarWidth,
    onTerminalSidebarWidthChange,
    position,
    onTogglePosition,
  }) => {
    const { dispatch } = useActionSystem();

    // Tab management (needed for native resize menu "Close panel")
    const { activeTab, handleTabChange, handleTogglePanel } =
      useBottomPanelTabs();

    // Workspace scan state & actions
    const { isScanning, scanResults, globalLspDiags, handleOpenLintScan } =
      useWorkspaceScan({ repoPath });

    // Problems collapse/expand + diagnostic merging
    const problemsState = useProblemsState({
      diagnostics,
      scanResultsByFile: scanResults.byFile,
      globalLspDiags,
      onClearAllDiagnostics,
    });

    const actions = useBottomPanelActions({
      activeTab,
      activeChannelId,
      onClearChannel,
      onClearAllDiagnostics: problemsState.handleClearAll,
      onToggleExpandAll: problemsState.handleToggleExpandAll,
      allCollapsed: problemsState.allCollapsed,
      problemsFileGroupCount: problemsState.groupedDiagnostics.length,
      onScanWorkspace:
        repoPath && onSetDiagnosticsForFile ? handleOpenLintScan : undefined,
      isScanning,
    });

    // Dispatch-based terminal handlers
    const handleKillTerminal = useCallback(() => {
      dispatch("terminal.close", {}, "user");
    }, [dispatch]);

    const handleAddTerminal = useCallback(
      (options?: {
        shell?: string;
        args?: string[];
        name?: string;
        profileId?: string;
      }) => {
        dispatch("terminal.new", options ?? {}, "user");
      },
      [dispatch]
    );

    const activeTerminalSession = terminalState.activeSession;

    // Tab configs
    // Bottom-panel Terminal is intentionally hidden while the standalone Terminal tab is the single source of truth.
    // const terminalTab = useTerminalTabConfig({
    //   terminalState,
    //   repoPath,
    //   sidebarWidth: terminalSidebarWidth,
    //   onSidebarWidthChange: onTerminalSidebarWidthChange,
    //   onFileLinkOpen: onTerminalFileLinkOpen,
    //   actions: actions.terminalActions,
    // });
    void terminalState;
    void terminalSidebarWidth;
    void onTerminalSidebarWidthChange;
    void onTerminalFileLinkOpen;

    const problemsTab = useProblemsTabConfig({
      diagnostics: problemsState.mergedDiagnostics,
      onDiagnosticClick,
      onClearAll: onClearAllDiagnostics,
      collapsedFiles: problemsState.collapsedFiles,
      onToggleFileGroup: problemsState.handleToggleFileGroup,
      actions: actions.problemsActions,
      isScanning,
    });

    const outputTab = useOutputTabConfig({
      channels: outputChannels,
      activeChannelId,
      actions: actions.outputActions,
    });

    const testResultsTab = useTestResultsTabConfig({
      onResultClick: onTestResultClick,
      actions: actions.testResultsActions,
    });

    const tabBadges = useMemo(
      () => ({
        [BOTTOM_PANEL_TABS.PROBLEMS]: problemsTab.badge,
      }),
      [problemsTab.badge]
    );

    const visibleActiveTab =
      activeTab === BOTTOM_PANEL_TABS.TERMINAL
        ? BOTTOM_PANEL_TABS.PROBLEMS
        : activeTab;

    return (
      <div className="group/panel relative flex h-full min-h-0 w-full flex-col bg-workstation-bg">
        {/* Header with tabs and controls */}
        <BottomPanelHeader
          activeTab={visibleActiveTab}
          onTabChange={handleTabChange}
          onClose={handleTogglePanel}
          outputChannels={outputChannels}
          activeChannelId={activeChannelId}
          onSetActiveChannel={onSetActiveChannel}
          onClearChannel={onClearChannel}
          onKillTerminal={handleKillTerminal}
          onAddTerminal={handleAddTerminal}
          terminalSessionName={
            activeTerminalSession
              ? getTerminalDisplayTitle(activeTerminalSession)
              : undefined
          }
          terminalShellPath={activeTerminalSession?.shell}
          terminalPid={activeTerminalSession?.pid}
          problemsActions={actions.problemsActions}
          tabBadges={tabBadges}
          position={position}
          onTogglePosition={onTogglePosition}
        />

        {/* Panel content - all tabs mounted, hidden via display:none */}
        {/* Bottom-panel Terminal is intentionally hidden while the standalone Terminal tab is the single source of truth. */}
        {/* terminalTab={terminalTab} */}
        <BottomPanelContent
          activeTab={visibleActiveTab}
          problemsTab={problemsTab}
          outputTab={outputTab}
          testResultsTab={testResultsTab}
        />
      </div>
    );
  }
);

EditorBottomPanel.displayName = "EditorBottomPanel";

export default EditorBottomPanel;

// Re-export types for convenience
export type { Diagnostic } from "./content/ProblemsContent/types";
export type { OutputChannel } from "./content/OutputContent/types";
