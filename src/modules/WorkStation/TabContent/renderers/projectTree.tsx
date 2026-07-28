/**
 * Renderer for `project-tree` tabs (ORG2-patch).
 */
import { useSetAtom } from "jotai";
import React, { memo, useCallback } from "react";

import { ProjectTreePage } from "@src/modules/ProjectManager/ProjectJourney";
import {
  createProjectJourneyTab,
  createWorkItemDetailTab,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";
import type { WorkStationTab } from "@src/store/workstation/tabs/types";

import type { UnifiedTabContentProps } from "../types";

function useOpenWorkStationTab() {
  const setLayout = useSetAtom(workstationLayoutAtom);
  return useCallback(
    (tab: WorkStationTab) => {
      setLayout((prev) => {
        const exists = prev.mainPane.tabs.some((item) => item.id === tab.id);
        const tabs = exists
          ? prev.mainPane.tabs.map((item) =>
              item.id === tab.id
                ? { ...item, ...tab, data: { ...item.data, ...tab.data } }
                : item
            )
          : [...prev.mainPane.tabs, tab];
        return {
          ...prev,
          mainPane: { ...prev.mainPane, tabs, activeTabId: tab.id },
        };
      });
    },
    [setLayout]
  );
}

const ProjectTreeTabRenderer: React.FC<UnifiedTabContentProps> = memo(() => {
  const openTab = useOpenWorkStationTab();

  return (
    <ProjectTreePage
      onOpenJourney={(projectId, projectSlug, projectName) => {
        openTab(
          createProjectJourneyTab({
            projectId,
            projectSlug,
            projectName,
          })
        );
      }}
      onOpenWorkItem={(workItemId, projectSlug) => {
        openTab(
          createWorkItemDetailTab(
            undefined,
            undefined,
            workItemId,
            workItemId,
            projectSlug
          )
        );
      }}
    />
  );
});

ProjectTreeTabRenderer.displayName = "ProjectTreeTabRenderer";
export default ProjectTreeTabRenderer;
