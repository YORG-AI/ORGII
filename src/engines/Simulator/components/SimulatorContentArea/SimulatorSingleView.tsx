/**
 * SimulatorSingleView Component
 *
 * Pure content frame for the simulator's single-view mode. Mirrors My Station
 * exactly: the frame owns no chrome at all — every app renders its own tab
 * bar (`ReplayTabBar` or a regular `TabBar`) with a leading slot containing
 * the app-switcher chip + primary-sidebar toggle. The tab bar is the single
 * top chrome row; the sidebar starts below it and never owns its own header.
 *
 * Frame-level responsibilities are limited to:
 * - rounding / background
 * - the floating replay controls
 * - empty-state placeholder
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { useSessionId } from "@src/engines/SessionCore/hooks/session";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import { NoTabsPlaceholder } from "@src/modules/WorkStation/shared";

import FloatingReplayContainer from "../FloatingReplayContainer";

interface SimulatorSingleViewProps {
  isBootingEvent: boolean;
  mainContentAppType: AppType | null;
  displayContent: React.ReactNode;
  hideHeader?: boolean;
  compactMode?: boolean;
}

export const SimulatorSingleView: React.FC<SimulatorSingleViewProps> = ({
  isBootingEvent,
  mainContentAppType,
  displayContent,
  hideHeader = false,
  compactMode = false,
}) => {
  const { t } = useTranslation("sessions");
  const { sessionId } = useSessionId();
  const hasSession = Boolean(sessionId);

  const showSessionPlaceholder =
    !hasSession && !displayContent && !isBootingEvent;
  const showEmptyTabsPlaceholder =
    hasSession && !displayContent && !isBootingEvent;

  const showRounded = !hideHeader;
  const showFloatingReplayControls =
    hasSession && mainContentAppType && mainContentAppType !== AppType.DIFF;

  return (
    <div
      className={`relative flex h-full w-full flex-col overflow-hidden ${showRounded ? "rounded-xl" : ""} bg-bg-2 ${compactMode ? "simulator-compact-mode" : ""}`}
    >
      <div className="relative min-h-0 flex-1 overflow-auto text-text-1">
        {showSessionPlaceholder ? (
          <NoTabsPlaceholder
            icon="simulator"
            caption={t("simulator.noActiveSession")}
          />
        ) : showEmptyTabsPlaceholder ? (
          <NoTabsPlaceholder icon="simulator" />
        ) : (
          displayContent
        )}
      </div>

      {showFloatingReplayControls && <FloatingReplayContainer />}
    </div>
  );
};
