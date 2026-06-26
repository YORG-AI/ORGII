import React, { memo } from "react";

import { classNames } from "@src/util/ui/classNames";

import { SimulatorTabBarLeading } from "../AppSwitcherWrappers";
import { type ReplayTab, ReplayTabBar } from "./ReplayTabBar";
import { SimulatorWorkstationTabHeader } from "./SimulatorWorkstationTabHeader";

export interface SimulatorReplayChromeProps {
  tabs: ReplayTab[];
  activeEventId: string | null;
  onTabClick: (eventId: string) => void;
  onTabDoubleClick?: (eventId: string) => void;
  children: React.ReactNode;
  leadingSlot?: React.ReactNode;
  trailingSlot?: React.ReactNode;
  showSidebarToggle?: boolean;
  sidebarToggleDisabled?: boolean;
  showWorkstationTabHeader?: boolean;
  tabBarSurfaceClassName?: string;
  className?: string;
}

const SimulatorReplayChromeComponent: React.FC<SimulatorReplayChromeProps> = ({
  tabs,
  activeEventId,
  onTabClick,
  onTabDoubleClick,
  children,
  leadingSlot,
  trailingSlot,
  showSidebarToggle = true,
  sidebarToggleDisabled = false,
  showWorkstationTabHeader = true,
  tabBarSurfaceClassName,
  className,
}) => {
  return (
    <div
      className={classNames("flex h-full min-h-0 w-full flex-col", className)}
    >
      <ReplayTabBar
        tabs={tabs}
        activeEventId={activeEventId}
        onTabClick={onTabClick}
        onTabDoubleClick={onTabDoubleClick}
        leadingSlot={leadingSlot ?? <SimulatorTabBarLeading />}
        trailingSlot={trailingSlot}
        surfaceClassName={tabBarSurfaceClassName}
      />
      {showWorkstationTabHeader && (
        <SimulatorWorkstationTabHeader
          showSidebarToggle={showSidebarToggle}
          sidebarToggleDisabled={sidebarToggleDisabled}
        />
      )}
      {children}
    </div>
  );
};

export const SimulatorReplayChrome = memo(SimulatorReplayChromeComponent);
SimulatorReplayChrome.displayName = "SimulatorReplayChrome";

export default SimulatorReplayChrome;
