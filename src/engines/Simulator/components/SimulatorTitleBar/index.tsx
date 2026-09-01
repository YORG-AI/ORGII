/**
 * SimulatorTitleBar Component
 *
 * Reusable window header for all simulator views.
 * Provides traffic lights, title, optional station-mode pill, and a slot for
 * custom right-side actions. Layout / panel-collapse controls live in the
 * tab bar (see WorkstationTabBar / ReplayTabBar trailing slots), not here.
 *
 * Used by: SimulatorContentArea, SimulatorFrame, ResizableSplitView
 */
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import TabPill from "@src/components/TabPill";
import type { IconSvgElement } from "@src/icons";
import type { StationMode } from "@src/store/ui/simulatorAtom";

interface SimulatorTitleBarProps {
  title?: string;
  /** Optional Hugeicons icon before title (same asset as dock for the active tool). */
  titleCenterIcon?: IconSvgElement;
  backgroundColor?: string;
  textColor?: string;
  showBorder?: boolean;
  customActions?: React.ReactNode;
  stationMode?: StationMode;
  onStationModeChange?: (mode: StationMode) => void;
  /** Which station modes to show in the pill. Defaults to both. */
  stationModeOptions?: StationMode[];
}

const SimulatorTitleBar: React.FC<SimulatorTitleBarProps> = memo(
  ({
    title,
    titleCenterIcon: TitleCenterIcon,
    backgroundColor,
    textColor,
    showBorder,
    customActions,
    stationMode,
    onStationModeChange,
    stationModeOptions,
  }) => {
    const { t } = useTranslation("common");
    const allStationTabs = useMemo(
      () => [
        { key: "my-station" as const, label: t("terminology.myStation") },
        { key: "agent-station" as const, label: t("terminology.agentStation") },
      ],
      [t]
    );
    const stationTabs = useMemo(() => {
      if (!stationModeOptions) return allStationTabs;
      return allStationTabs.filter((tab) =>
        stationModeOptions.includes(tab.key)
      );
    }, [allStationTabs, stationModeOptions]);
    const showStationSwitch = stationTabs.length > 0 && !!stationMode;
    const handleDeskChange = useCallback(
      (key: string) => onStationModeChange?.(key as StationMode),
      [onStationModeChange]
    );

    const borderClass =
      showBorder === false
        ? ""
        : showBorder === true || !backgroundColor
          ? "border-b border-border-2"
          : "";

    const paddingClass = customActions ? "pl-4 pr-3" : "px-4";

    return (
      <div
        className={`relative z-10 flex h-10 flex-none items-center bg-bg-1 ${paddingClass} ${borderClass}`}
        style={backgroundColor ? { backgroundColor } : undefined}
      >
        {/* Center: title (+ optional station mode switch) — geometric center of the bar */}
        <div className="absolute top-1/2 left-1/2 z-10 flex max-w-[calc(100%-9rem)] -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-3">
          {title ? (
            <span className="flex min-w-0 items-center gap-1.5">
              {TitleCenterIcon ? (
                <AnyIcon
                  icon={TitleCenterIcon}
                  size={16}
                  strokeWidth={1.75}
                  className="shrink-0 text-text-2"
                  aria-hidden
                  style={textColor ? { color: textColor } : undefined}
                />
              ) : null}
              <span
                className="min-w-0 truncate text-center text-[13px] font-medium text-text-2"
                style={textColor ? { color: textColor } : undefined}
              >
                {title}
              </span>
            </span>
          ) : null}
          {showStationSwitch && (
            <TabPill
              tabs={stationTabs}
              activeTab={stationMode}
              onChange={handleDeskChange}
              variant="pill"
              color="fill"
              size="small"
              fillWidth={false}
            />
          )}
        </div>

        {/* Right: caller-supplied actions only (panel toggles live in the tab bar) */}
        {customActions ? (
          <div className="ml-auto flex items-center gap-1.5">
            {customActions}
          </div>
        ) : null}
      </div>
    );
  }
);

SimulatorTitleBar.displayName = "SimulatorTitleBar";

export default SimulatorTitleBar;
