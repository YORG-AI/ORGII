import { SIDEBAR_MEMORY_KIND, useSidebarMemoryEntry } from "@src/hooks/perf";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import type { WorkstationSidebarKey } from "./types";

const WORKSTATION_SIDEBAR_MEMORY_LABEL: Record<WorkstationSidebarKey, string> =
  {
    folders: "Folders sidebar",
    projects: "Projects sidebar",
    workstation: "Session sidebar",
  };

interface UseWorkstationSidebarMemoryParams {
  activeSessionId: string;
  activeSidebarKey: WorkstationSidebarKey;
  allSectionIds: readonly string[];
  collapsedSectionIds: ReadonlySet<string>;
  groupByMode: string;
  pinnedMenuItems: readonly NavigationMenuItem[];
  selectedMenuItemId: string;
  sidebarMenuItems: readonly NavigationMenuItem[];
  tabCount: number;
}

export function useWorkstationSidebarMemory({
  activeSessionId,
  activeSidebarKey,
  allSectionIds,
  collapsedSectionIds,
  groupByMode,
  pinnedMenuItems,
  selectedMenuItemId,
  sidebarMenuItems,
  tabCount,
}: UseWorkstationSidebarMemoryParams): void {
  useSidebarMemoryEntry({
    kind: SIDEBAR_MEMORY_KIND.SESSION,
    label: WORKSTATION_SIDEBAR_MEMORY_LABEL[activeSidebarKey],
    items: pinnedMenuItems.length + sidebarMenuItems.length,
    sections: allSectionIds.length,
    tabs: tabCount,
    source: {
      activeSessionId,
      collapsedSectionIds: Array.from(collapsedSectionIds),
      groupByMode,
      pinnedMenuItems,
      selectedMenuItemId,
      sidebarMenuItems,
    },
  });
}
