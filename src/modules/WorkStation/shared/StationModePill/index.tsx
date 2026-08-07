/**
 * StationModePill Component
 *
 * Renders the My Station / Agent's Station icon segmented toggle.
 */
import { useAtom } from "jotai";
import { Infinity, Laptop, type LucideIcon } from "lucide-react";
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import SegmentedIconButton from "@src/components/SegmentedIconButton";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { GENERAL_LAYOUT_TOUR_TARGETS } from "@src/scaffold/Tutorials/generalLayoutTourConfig";
import { type StationMode, stationModeAtom } from "@src/store/ui/simulatorAtom";

import { WorkstationToolbarTooltip } from "../WorkstationToolbarTooltip";

const MY_STATION_SHORTCUT_ID = "open_my_station";
const AGENT_STATION_SHORTCUT_ID = "open_agent_station";

interface IconSwitchButtonProps {
  label: string;
  tooltipLabel: string;
  selected: boolean;
  onClick: () => void;
  icon: LucideIcon;
  testId?: string;
  shortcut: string;
  selectedClassName?: string;
}

const IconSwitchButton: React.FC<IconSwitchButtonProps> = ({
  label,
  tooltipLabel,
  selected,
  onClick,
  icon: Icon,
  testId,
  shortcut,
  selectedClassName = "bg-primary-6 text-white",
}) => {
  const buttonSizeClass = "h-6 w-7";

  return (
    <WorkstationToolbarTooltip
      label={tooltipLabel}
      shortcut={shortcut || undefined}
      position="bottom"
    >
      <span className="inline-flex">
        <SegmentedIconButton
          icon={Icon}
          selected={selected}
          onClick={onClick}
          ariaLabel={label}
          ariaPressed={selected}
          testId={testId}
          sizeClassName={buttonSizeClass}
          selectedClassName={selectedClassName}
          unselectedClassName="bg-transparent text-text-1 hover:bg-fill-3"
          transitionClassName="transition-colors duration-150"
          strokeWidth={1.85}
        />
      </span>
    </WorkstationToolbarTooltip>
  );
};

const StationModePill: React.FC = () => {
  const [stationMode, setStationMode] = useAtom(stationModeAtom);

  const { t } = useTranslation("common");
  const mySegment = t("terminology.myStation");
  const agentSegment = t("terminology.agentStation");

  const myStationShortcut = getShortcutKeys(MY_STATION_SHORTCUT_ID);
  const agentStationShortcut = getShortcutKeys(AGENT_STATION_SHORTCUT_ID);
  const handleChange = useCallback(
    (mode: StationMode) => {
      setStationMode(mode);
    },
    [setStationMode]
  );

  return (
    <div
      className="flex items-center gap-px rounded-[100px] border border-border-2 bg-fill-1 p-0.5"
      data-tour-target={GENERAL_LAYOUT_TOUR_TARGETS.stationModePill}
    >
      <IconSwitchButton
        label={mySegment}
        tooltipLabel={t("actions.switchToStation", { station: mySegment })}
        icon={Laptop}
        selected={stationMode === "my-station"}
        onClick={() => handleChange("my-station")}
        testId="station-mode-my-station"
        shortcut={myStationShortcut}
      />
      <IconSwitchButton
        label={agentSegment}
        tooltipLabel={t("actions.switchToStation", { station: agentSegment })}
        icon={Infinity}
        selected={stationMode === "agent-station"}
        onClick={() => handleChange("agent-station")}
        testId="station-mode-agent-station"
        shortcut={agentStationShortcut}
      />
    </div>
  );
};

export default StationModePill;
