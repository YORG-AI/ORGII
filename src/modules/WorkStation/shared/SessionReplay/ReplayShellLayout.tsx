import React, { memo } from "react";

import { Placeholder } from "@src/components/Placeholder";
import EventWrapper from "@src/engines/ChatPanel/adapters/EventWrapper";
import type { BackendEvent } from "@src/types/session/steps";
import { classNames } from "@src/util/ui/classNames";

import { NoTabsPlaceholder } from "../NoTabsPlaceholder";
import type { PlaceholderIcon } from "../NoTabsPlaceholder";
import type { QuickAction } from "../QuickActionsPanel/types";
import { WorkStationShell } from "../WorkStationShell";
import type {
  PrimarySidebarConfig,
  SecondaryPanelConfig,
} from "../WorkStationShell/config";
import type { SessionReplayPlaceholderMode } from "../useSimulatorPlaceholderActions";
import type { ReplayTab } from "./ReplayTabBar";
import { SimulatorReplayChrome } from "./SimulatorReplayChrome";
import type { ReplayShellLayoutMode } from "./replayShellHelpers";

export interface ReplayShellWorkstationConfig {
  primarySidebarConfig?: PrimarySidebarConfig;
  secondaryPanelConfig?: SecondaryPanelConfig;
  statusBar?: React.ReactNode | null;
  appClassName?: string;
  layoutMode: ReplayShellLayoutMode;
}

export interface ReplayShellLayoutProps {
  tabs: ReplayTab[];
  activeEventId: string | null;
  onTabClick: (eventId: string) => void;
  children: React.ReactNode;
  trailingSlot?: React.ReactNode;
  sidebarToggleDisabled?: boolean;
  showWorkstationTabHeader?: boolean;
  event?: unknown;
  eventMode?: SessionReplayPlaceholderMode;
  workstation?: ReplayShellWorkstationConfig;
  contentWrapperClassName?: string;
}

export interface ReplayShellPlaceholderProps {
  isLoading: boolean;
  icon: PlaceholderIcon;
  caption: string;
  actions: QuickAction[];
  className?: string;
}

export const ReplayShellPlaceholder: React.FC<ReplayShellPlaceholderProps> =
  memo(({ isLoading, icon, caption, actions, className }) => (
    <div className={classNames("min-h-0 flex-1", className)}>
      {isLoading ? (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          fillParentHeight
        />
      ) : (
        <NoTabsPlaceholder icon={icon} caption={caption} actions={actions} />
      )}
    </div>
  ));
ReplayShellPlaceholder.displayName = "ReplayShellPlaceholder";

const ReplayShellLayoutComponent: React.FC<ReplayShellLayoutProps> = ({
  tabs,
  activeEventId,
  onTabClick,
  children,
  trailingSlot,
  sidebarToggleDisabled,
  showWorkstationTabHeader,
  event,
  eventMode = "simulation",
  workstation,
  contentWrapperClassName,
}) => {
  const body = workstation ? (
    <div className={classNames("flex min-h-0 flex-1", contentWrapperClassName)}>
      <WorkStationShell
        primarySidebarConfig={workstation.primarySidebarConfig}
        secondaryPanelConfig={workstation.secondaryPanelConfig}
        content={children}
        statusBar={workstation.statusBar ?? null}
        layoutMode={workstation.layoutMode}
        appClassName={workstation.appClassName}
      />
    </div>
  ) : (
    children
  );

  const chrome = (
    <SimulatorReplayChrome
      tabs={tabs}
      activeEventId={activeEventId}
      onTabClick={onTabClick}
      trailingSlot={trailingSlot}
      sidebarToggleDisabled={sidebarToggleDisabled}
      showWorkstationTabHeader={showWorkstationTabHeader}
    >
      {body}
    </SimulatorReplayChrome>
  );

  if (event === undefined) {
    return chrome;
  }

  return (
    <EventWrapper
      event={event as unknown as BackendEvent}
      mode={eventMode}
      expand={true}
      padding="p-0"
    >
      {chrome}
    </EventWrapper>
  );
};

export const ReplayShellLayout = memo(ReplayShellLayoutComponent);
ReplayShellLayout.displayName = "ReplayShellLayout";
