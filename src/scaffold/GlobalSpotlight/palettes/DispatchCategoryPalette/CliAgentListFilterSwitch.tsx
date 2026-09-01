import React from "react";

import { CLI_LAUNCH_MODE, type CliLaunchMode } from "@src/store/session";

interface CliAgentListFilterSwitchProps {
  mode: CliLaunchMode;
  onModeChange: (mode: CliLaunchMode) => void;
  className?: string;
}

export const CliAgentListFilterSwitch: React.FC<
  CliAgentListFilterSwitchProps
> = ({ mode, onModeChange, className = "" }) => {
  const guiSelected = mode === CLI_LAUNCH_MODE.GUI;
  const tuiSelected = mode === CLI_LAUNCH_MODE.TUI;

  return (
    <div
      className={`inline-flex h-[28px] items-center rounded-full bg-fill-2 p-0.5 text-[12px] font-medium ${className}`}
    >
      <button
        type="button"
        className={`h-6 rounded-full px-2.5 py-0 transition-colors ${
          guiSelected
            ? "bg-bg-2 text-text-1 shadow-sm"
            : "text-text-3 hover:text-text-1"
        }`}
        aria-pressed={guiSelected}
        onClick={() => onModeChange(CLI_LAUNCH_MODE.GUI)}
      >
        GUI
      </button>
      <button
        type="button"
        className={`h-6 rounded-full px-2.5 py-0 transition-colors ${
          tuiSelected
            ? "bg-bg-2 text-text-1 shadow-sm"
            : "text-text-3 hover:text-text-1"
        }`}
        aria-pressed={tuiSelected}
        onClick={() => onModeChange(CLI_LAUNCH_MODE.TUI)}
      >
        TUI
      </button>
    </div>
  );
};

export default CliAgentListFilterSwitch;
