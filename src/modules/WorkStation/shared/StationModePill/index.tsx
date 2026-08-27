/**
 * StationModePill Component
 *
 * Renders the My Station / Agent's Station icon segmented toggle.
 */
import { useAtom } from "jotai";
import { Infinity, Laptop, type LucideIcon } from "lucide-react";
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { GENERAL_LAYOUT_TOUR_TARGETS } from "@src/scaffold/Tutorials/generalLayoutTourConfig";
import { type StationMode, stationModeAtom } from "@src/store/ui/simulatorAtom";

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
}

const IconSwitchButton: React.FC<IconSwitchButtonProps> = ({
  label,
  tooltipLabel,
  selected,
  onClick,
  icon: Icon,
  testId,
  shortcut,
}) => {
  return (
    <ToolbarTooltip
      label={tooltipLabel}
      shortcut={shortcut || undefined}
      position="bottom"
    >
      <span className="inline-flex">
        <Button
          appearance={selected ? "solid" : "ghost"}
          variant={selected ? "primary" : "secondary"}
          size="mini"
          shape="round"
          iconOnly
          icon={<Icon size={16} strokeWidth={1.85} />}
          onClick={onClick}
          aria-label={label}
          aria-pressed={selected}
          data-testid={testId}
          className={`h-6 w-7 ${
            selected ? "" : "bg-transparent text-text-1 enabled:hover:bg-fill-3"
          }`}
          style={{ height: 24, width: 28 }}
        />
      </span>
    </ToolbarTooltip>
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
