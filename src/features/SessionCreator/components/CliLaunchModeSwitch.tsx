import React from "react";

import SegmentedTextPill from "@src/components/SegmentedTextPill";
import { CLI_LAUNCH_MODE, type CliLaunchMode } from "@src/store/session";

export interface CliLaunchModeSwitchProps {
  mode: CliLaunchMode;
  supportsGui: boolean;
  onModeChange: (mode: CliLaunchMode) => void;
  className?: string;
}

export const CliLaunchModeSwitch: React.FC<CliLaunchModeSwitchProps> = ({
  mode,
  supportsGui,
  onModeChange,
  className = "",
}) => {
  const selectedMode =
    mode === CLI_LAUNCH_MODE.GUI && supportsGui
      ? CLI_LAUNCH_MODE.GUI
      : CLI_LAUNCH_MODE.TUI;

  return (
    <SegmentedTextPill
      ariaLabel="GUI / TUI"
      className={className}
      value={selectedMode}
      options={[
        { value: CLI_LAUNCH_MODE.GUI, label: "GUI", disabled: !supportsGui },
        { value: CLI_LAUNCH_MODE.TUI, label: "TUI" },
      ]}
      onChange={onModeChange}
    />
  );
};

export default CliLaunchModeSwitch;
