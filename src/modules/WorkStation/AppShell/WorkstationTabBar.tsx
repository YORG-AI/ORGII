/**
 * Shared TabBar for My Station: Code / Browser / Project Manager
 * filter to their own tab host.
 */
import { useAtomValue } from "jotai";
import React, { memo } from "react";

import {
  TabBar,
  WorkStationTabBarLeading,
} from "@src/modules/WorkStation/shared";
import { CODE_EDITOR_TOUR_TARGETS } from "@src/scaffold/Tutorials/codeEditorTourConfig";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import type { WorkstationTabHost } from "@src/store/workstation/tabHost";

import { useWorkstationTabList } from "./useWorkstationTabList";
import { useWorkstationTrailingSlot } from "./useWorkstationTrailingSlot";

// Stable element reference so memoized TabBar sees the same leadingSlot each render.
const LEADING_SLOT = <WorkStationTabBarLeading />;

export interface WorkstationTabBarProps {
  /** The active tab's host — always one of code / browser / project. */
  host: WorkstationTabHost;
}

const WorkstationTabBar: React.FC<WorkstationTabBarProps> = memo(({ host }) => {
  const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);

  const {
    tabsForBar,
    activeKey,
    visible,
    handleTabClick,
    handleTabReorder,
    handleTabClose,
    handleCloseOther,
    handleCloseSaved,
  } = useWorkstationTabList();

  const { trailingSlot } = useWorkstationTrailingSlot({
    host,
    visible,
  });

  return (
    <TabBar
      paneId={`workstation-${host}`}
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
      onNewTabShortcutId={host === "browser" ? "browser_new_tab" : undefined}
      surfaceClassName=""
      dataTourTarget={CODE_EDITOR_TOUR_TARGETS.tabBar}
    />
  );
});

WorkstationTabBar.displayName = "WorkstationTabBar";

export default WorkstationTabBar;
