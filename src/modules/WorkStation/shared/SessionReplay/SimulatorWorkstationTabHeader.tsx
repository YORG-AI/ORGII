/**
 * SimulatorWorkstationTabHeader
 *
 * Shared 40px global tab-header strip rendered immediately below the
 * {@link ReplayTabBar} in simulator replay views (Agent Station's Code
 * Editor, Browser, Database Manager, Project Manager, Communication).
 * Mirrors My Station's `WorkstationTabHeader` so the chrome shape stays
 * identical across products.
 *
 * Layout:
 *   [ sidebar toggle ] [ leading ] [ content ] [ trailing ]
 *
 * Why a single shared component (vs. per-app inline headers): every
 * simulator app needs the same sidebar toggle in the same position and
 * the same alignment with the app-switcher chip directly above it.
 * Lifting the toggle here also keeps the {@link ReplayTabBar}
 * `leadingSlot` lean — just the app-switcher chip — matching the My
 * Station shell.
 *
 * Right-side content is published by the active simulator pane via
 * `usePublishWorkstationTabHeader({ host: "simulator", ... })` (typically
 * indirectly through `<FileHeader publishToHost="simulator" />`). Routing
 * through an atom — instead of a prop — lets nested components like
 * `CodePanel` teleport their existing breadcrumb into this strip without
 * the simulator entry having to know which sub-mode is active.
 */
import { useAtomValue } from "jotai";
import React, { memo } from "react";

import { workstationTabHeaderAtomByHost } from "@src/store/workstation";

import { NoDragRegion } from "../NoDragRegion";
import { SimulatorSidebarToggleButton } from "../SidebarToggleButton";
import { WorkstationHeaderSectionSeparator } from "../WorkstationHeaderSectionSeparator";
import { WorkstationTabHeaderSlotsView } from "../WorkstationTabHeaderSlotsView";

export interface SimulatorWorkstationTabHeaderProps {
  showSidebarToggle?: boolean;
  sidebarToggleDisabled?: boolean;
}

const SimulatorWorkstationTabHeaderComponent: React.FC<
  SimulatorWorkstationTabHeaderProps
> = ({ showSidebarToggle = true, sidebarToggleDisabled = false }) => {
  const headerSlots = useAtomValue(workstationTabHeaderAtomByHost.simulator);

  // Border lives on this row (not on `ReplayTabBar` above) so the chrome
  // shape mirrors My Station: tab bar transparent, header strip carries
  // the single separator line under the whole tabbar+header block.
  return (
    <div
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border-2 pl-1.5 pr-2"
      data-tauri-drag-region
    >
      <NoDragRegion className="flex w-7 shrink-0 items-center justify-center">
        {showSidebarToggle ? (
          <SimulatorSidebarToggleButton
            iconSize={14}
            disabled={sidebarToggleDisabled}
          />
        ) : null}
      </NoDragRegion>
      <WorkstationHeaderSectionSeparator />
      <WorkstationTabHeaderSlotsView slots={headerSlots} />
    </div>
  );
};

export const SimulatorWorkstationTabHeader = memo(
  SimulatorWorkstationTabHeaderComponent
);
SimulatorWorkstationTabHeader.displayName = "SimulatorWorkstationTabHeader";

export default SimulatorWorkstationTabHeader;
