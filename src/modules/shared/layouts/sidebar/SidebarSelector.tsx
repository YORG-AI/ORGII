/**
 * Sidebar Selector Component
 *
 * The active Workbench route owns exactly one sidebar. Settings and
 * WorkStation sidebars unmount when their route branch is inactive.
 */
import { WorkstationSidebarConnector } from "@/src/scaffold/NavigationSidebar/connectors";
import SettingsSidebar from "@/src/scaffold/NavigationSidebar/variants/SettingsSidebar";
import React from "react";

import { GENERAL_LAYOUT_TOUR_TARGETS } from "@src/scaffold/Tutorials/generalLayoutTourConfig";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";

import { useRouteLayoutType } from "../../hooks";

export const SidebarSelector: React.FC = React.memo(() => {
  const layoutType = useRouteLayoutType();

  if (layoutType === "settings") {
    return (
      <div style={{ flexShrink: 0 }} data-guide-target={GUIDE_TARGETS.SIDEBAR}>
        <SettingsSidebar />
      </div>
    );
  }

  if (layoutType !== "session") return null;

  return (
    <div
      style={{ flexShrink: 0 }}
      data-guide-target={GUIDE_TARGETS.SIDEBAR}
      data-tour-target={GENERAL_LAYOUT_TOUR_TARGETS.sessionSidebar}
    >
      <WorkstationSidebarConnector />
    </div>
  );
});

SidebarSelector.displayName = "SidebarSelector";
