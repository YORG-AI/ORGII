/**
 * Shared TabBar for My Station: Code / Browser / Database / Project Manager
 * filter to their own tab host.
 */
import { useAtomValue } from "jotai";
import React, { memo } from "react";

import type { AppModeType } from "@src/config/viewModeTypes";
import {
  TabBar,
  WorkStationTabBarLeading,
} from "@src/modules/WorkStation/shared";
import { CODE_EDITOR_TOUR_TARGETS } from "@src/scaffold/Tutorials/codeEditorTourConfig";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";

import { useWorkstationTabList } from "./useWorkstationTabList";
import { useWorkstationTrailingSlot } from "./useWorkstationTrailingSlot";

export { OpsControlStationTabBar } from "./OpsControlStationTabBar";

const WORKSTATION_SINGLE_HOST_MODES: AppModeType[] = [
  "code",
  "browser",
  "data",
  "project",
];

// Stable element reference so memoized TabBar sees the same leadingSlot each render.
const LEADING_SLOT = <WorkStationTabBarLeading />;

export interface WorkstationTabBarProps {
  appMode: AppModeType;
}

const WorkstationTabBar: React.FC<WorkstationTabBarProps> = memo(
  ({ appMode }) => {
    const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);

    const {
      tabsForBar,
      activeKey,
      isAllTabsView,
      visible,
      handleTabClick,
      handleTabReorder,
      handleTabClose,
      handleCloseOther,
      handleCloseSaved,
    } = useWorkstationTabList();

    const { trailingSlot } = useWorkstationTrailingSlot({
      appMode,
      isAllTabsView,
      visible,
    });

    if (!WORKSTATION_SINGLE_HOST_MODES.includes(appMode)) {
      return null;
    }

    return (
      <TabBar
        paneId={`workstation-${appMode}`}
        tabs={tabsForBar}
        activeTabId={activeKey}
        onTabClick={handleTabClick}
        onTabClose={handleTabClose}
        onTabReorder={handleTabReorder}
        onCloseOtherTabs={handleCloseOther}
        onCloseSavedTabs={handleCloseSaved}
        repoPath={activeWorkspaceRootPath}
        leadingSlot={LEADING_SLOT}
        trailingSlot={trailingSlot}
        onNewTabShortcutId={
          appMode === "browser" ? "browser_new_tab" : undefined
        }
        surfaceClassName=""
        dataTourTarget={CODE_EDITOR_TOUR_TARGETS.tabBar}
      />
    );
  }
);

WorkstationTabBar.displayName = "WorkstationTabBar";

export default WorkstationTabBar;
