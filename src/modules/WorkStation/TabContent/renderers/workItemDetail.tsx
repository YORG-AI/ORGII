/**
 * Renderer wrapper for `workItem-detail` tabs.
 *
 * Renders `WorkItemDetailPage` through the unified dispatcher, pulling its
 * close / chat / tab-meta callbacks from the hoisted Project host context —
 * mirroring `ProjectManagerContentRouter`.
 */
import React, { memo } from "react";

import { useProjectHostContext } from "@src/modules/ProjectManager/ProjectManagerLayout/context/projectHostContext";
import WorkItemDetailPage from "@src/modules/ProjectManager/WorkItems/components/WorkItemDetailPage";
import { getWorkItemDetailTabChrome } from "@src/store/workstation/tabs";

import type { UnifiedTabContentProps } from "../types";

const WorkItemDetailTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const { onCloseTab, onOpenChatSession, onUpdateTabData, onUpdateTabMeta } =
      useProjectHostContext();

    return (
      <WorkItemDetailPage
        projectId={tab.data.projectId as string}
        projectName={tab.data.projectName as string}
        projectSlug={tab.data.projectSlug as string | undefined}
        workItemId={tab.data.workItemId as string}
        onClose={() => onCloseTab(tab.id)}
        onOpenChatSession={onOpenChatSession}
        pendingUpdates={
          tab.data.pendingUpdates as Record<string, unknown> | undefined
        }
        publishHeaderToWorkstation
        onWorkItemNameUpdated={(workItemName) => {
          onUpdateTabData(tab.id, { workItemName });
          onUpdateTabMeta(tab.id, getWorkItemDetailTabChrome(workItemName));
        }}
        onWorkItemStatusResolved={(workItemStatus) => {
          if (tab.data.workItemStatus !== workItemStatus) {
            onUpdateTabData(tab.id, { workItemStatus });
          }
        }}
      />
    );
  }
);

WorkItemDetailTabRenderer.displayName = "WorkItemDetailTabRenderer";

export default WorkItemDetailTabRenderer;
