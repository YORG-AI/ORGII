/**
 * StationModePill Component
 *
 * Renders the My Station / Agent's Station icon segmented toggle.
 */
import { useAtom } from "jotai";
import { GitFork, Infinity, Laptop, type LucideIcon, Radar } from "lucide-react";
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import SegmentedIconButton from "@src/components/SegmentedIconButton";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { ROUTES } from "@src/config/routes";
import { GENERAL_LAYOUT_TOUR_TARGETS } from "@src/scaffold/Tutorials/GeneralLayoutTour";
import { type StationMode, stationModeAtom } from "@src/store/ui/simulatorAtom";

import { WorkstationToolbarTooltip } from "../WorkstationToolbarTooltip";

const MY_STATION_SHORTCUT_ID = "open_my_station";
const AGENT_STATION_SHORTCUT_ID = "open_agent_station";
const OPS_CONTROL_SHORTCUT_ID = "open_ops_control";
const JOURNEY_SHORTCUT_ID = "open_journey";

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
  const navigate = useNavigate();
  const location = useLocation();

  const { t } = useTranslation("common");
  const mySegment = t("terminology.myStation");
  const agentSegment = t("terminology.agentStation");
  const opsControlSegment = t("navigation:routes.opsControl");
  const journeySegment = t("navigation:routes.journey", {
    defaultValue: "Journey",
  });

  const myStationShortcut = getShortcutKeys(MY_STATION_SHORTCUT_ID);
  const agentStationShortcut = getShortcutKeys(AGENT_STATION_SHORTCUT_ID);
  const opsControlShortcut = getShortcutKeys(OPS_CONTROL_SHORTCUT_ID);
  const journeyShortcut = getShortcutKeys(JOURNEY_SHORTCUT_ID);
  const activeStationMode = stationMode;

  const handleChange = useCallback(
    (mode: StationMode) => {
      setStationMode(mode);

      if (mode === "ops-control") {
        if (location.pathname !== ROUTES.workStation.opsControl.path) {
          navigate(ROUTES.workStation.opsControl.path);
        }
        return;
      }

      if (mode === "journey") {
        if (location.pathname !== ROUTES.workStation.journey.path) {
          navigate(ROUTES.workStation.journey.path);
        }
        return;
      }

      if (
        location.pathname === ROUTES.workStation.opsControl.path ||
        location.pathname === ROUTES.workStation.journey.path
      ) {
        navigate(ROUTES.workStation.base.path);
      }
    },
    [location.pathname, navigate, setStationMode]
  );

  return (
    <div
      className="flex items-center gap-px rounded-[100px] border border-border-2 bg-fill-1 p-0.5"
      data-tour-target={GENERAL_LAYOUT_TOUR_TARGETS.stationModePill}
    >
      {activeStationMode === "journey" && (
        <IconSwitchButton
          label={journeySegment}
          tooltipLabel={t("actions.switchToStation", {
            station: journeySegment,
          })}
          icon={GitFork}
          selected
          onClick={() => handleChange("journey")}
          testId="station-mode-journey"
          shortcut={journeyShortcut}
          selectedClassName="bg-success-6 text-white"
        />
      )}
      {activeStationMode === "ops-control" && (
        <IconSwitchButton
          label={opsControlSegment}
          tooltipLabel={t("actions.switchToStation", {
            station: opsControlSegment,
          })}
          icon={Radar}
          selected
          onClick={() => handleChange("ops-control")}
          testId="station-mode-ops-control"
          shortcut={opsControlShortcut}
          selectedClassName="bg-warning-6 text-white"
        />
      )}
      <IconSwitchButton
        label={mySegment}
        tooltipLabel={t("actions.switchToStation", { station: mySegment })}
        icon={Laptop}
        selected={activeStationMode === "my-station"}
        onClick={() => handleChange("my-station")}
        testId="station-mode-my-station"
        shortcut={myStationShortcut}
      />
      <IconSwitchButton
        label={agentSegment}
        tooltipLabel={t("actions.switchToStation", { station: agentSegment })}
        icon={Infinity}
        selected={activeStationMode === "agent-station"}
        onClick={() => handleChange("agent-station")}
        testId="station-mode-agent-station"
        shortcut={agentStationShortcut}
      />
    </div>
  );
};

export default StationModePill;
