/**
 * WorkStationPage - Main page for Workstation
 *
 * Renders AppShell which handles:
 * - SimulatorFrame wrapper with panel controls
 * - Repository path validation
 * - App mode switching (CodeEditor/Browser/DatabaseManager)
 *
 * ChatPanel is rendered by AppLayout using the single Modern layout.
 */
import React from "react";

import AppShell from "./AppShell";

interface WorkStationPageProps {
  /** Whether the routed WorkStation surface is currently visible */
  isActive?: boolean;
  /** Whether the chat panel is taking over the WorkStation surface */
  chatPanelFocused?: boolean;
}

const WorkStationPage: React.FC<WorkStationPageProps> = ({
  isActive = true,
  chatPanelFocused = false,
}) => {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <AppShell isActive={isActive} chatPanelFocused={chatPanelFocused} />
    </div>
  );
};

export default WorkStationPage;
