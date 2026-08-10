/**
 * Renderer for `project-tree` tabs.
 */
import { useSetAtom } from "jotai";
import React, { memo, useCallback } from "react";

import { ProjectTreePage } from "@src/modules/ProjectManager/ProjectJourney";
import {
  createChatSessionTab,
  createProjectJourneyTab,
  createSessionJourneyTab,
  createWorkItemDetailTab,
  openTab as openPanelTab,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";
import type { WorkStationTab } from "@src/store/workstation/tabs/types";

import type { UnifiedTabContentProps } from "../types";

function useOpenWorkStationTab() {
  const setLayout = useSetAtom(workstationLayoutAtom);
  return useCallback(
    (tab: WorkStationTab) => {
      setLayout((prev) => ({
        ...prev,
        mainPane: openPanelTab(prev.mainPane, tab),
      }));
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
      onOpenSession={(
        sessionId,
        sessionTitle,
        workItemId,
        _projectSlug,
        initialMessageId
      ) => {
        openTab(
          createChatSessionTab(
            sessionId,
            sessionTitle || sessionId.slice(0, 8),
            workItemId,
            undefined,
            initialMessageId
          )
        );
      }}
      onOpenSessionJourney={(sessionId, sessionName, target) => {
        openTab(
          createSessionJourneyTab({
            sessionId,
            sessionName,
            selectedTaskId: target?.taskId,
            selectedForkId: target?.forkId,
            selectedAnchorMessageId: target?.anchorMessageId,
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
