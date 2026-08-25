/**
 * EditorBottomPanel Types
 *
 * Shared types for the bottom panel component.
 */
import type { UseTerminalStateReturn } from "@/src/engines/TerminalCore/exports";
import type { ReactNode } from "react";

import type { BottomPanelTab } from "@src/store/ui/workStationAtom";

import type { OutputChannel } from "./content/OutputContent/types";
import type { Diagnostic } from "./content/ProblemsContent/types";

export interface EditorBottomPanelProps {
  // Problems
  diagnostics: Diagnostic[];
  onDiagnosticClick: (diagnostic: Diagnostic) => void;
  onClearAllDiagnostics: () => void;

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
}

export type BottomPanelViewMode = BottomPanelTab;

/**
 * Tab action configuration
 */
export interface TabAction {
  key: string;
  icon: ReactNode;
  tooltip: string;
  onClick: () => void;
  danger?: boolean;
  active?: boolean;
}

/**
 * Tab configuration returned by tab config hooks
 */
export interface TabConfig {
  key: string;
  icon: string;
  title: string;
  content: ReactNode;
  actions?: TabAction[];
  /** Badge shown in tab pill (e.g. count component) */
  badge?: ReactNode;
}
