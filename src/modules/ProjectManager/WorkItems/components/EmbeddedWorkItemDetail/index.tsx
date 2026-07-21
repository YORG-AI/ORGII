import React, { Suspense, useCallback } from "react";

import type { WorkstationTabHeaderHost } from "@src/hooks/workStation";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import type { Person } from "@src/types/core/shared";
import type {
  WorkItem as WorkItemExtended,
  WorkItemLabel,
  WorkItemMilestone,
  WorkItemProject,
} from "@src/types/core/workItem";

import {
  WORK_ITEM_DETAIL_SURFACE,
  type WorkItemDetailActions,
} from "../WorkItemDetail";

const WorkItemDetail = React.lazy(() => import("../WorkItemDetail"));

interface EmbeddedWorkItemDetailProps {
  workItem: WorkItemExtended | null;
  onClose: () => void;
  onNavigate: (direction: "prev" | "next") => void;
  hasPrev: boolean;
  hasNext: boolean;
  onUpdateWorkItem: (
    workItemId: string,
    updates: Partial<WorkItemExtended>
  ) => void;
  onDeleteWorkItem: (workItemId: string) => Promise<void>;
  availableMembers: Person[];
  availableProjects: WorkItemProject[];
  availableMilestones: WorkItemMilestone[];
  availableLabels: WorkItemLabel[];
  onPendingChangesChange: (hasPending: boolean) => void;
  onRegisterActions?: (actions: WorkItemDetailActions) => void;
  repoPath: string | null;
  projectSlug: string | null;
  shortId: string | null;
  onRefreshWorkItem: () => Promise<void>;
  onOpenSession?: (sessionId: string, title?: string) => void;
  onWorkItemNameUpdated?: (workItemName: string) => void;
  onExpandWorkItemToTab?: (
    workItemId: string,
    workItemName: string,
    pendingUpdates?: Record<string, unknown>
  ) => void;
  breadcrumbProjectName: string;
  breadcrumbIcon?: React.ReactNode;
  propertiesOpen: boolean;
  onToggleProperties: () => void;
  publishHeaderToWorkstation: boolean;
  workstationHeaderHost?: WorkstationTabHeaderHost;
}

const EmbeddedWorkItemDetail: React.FC<EmbeddedWorkItemDetailProps> = ({
  workItem,
  onClose,
  onNavigate,
  hasPrev,
  hasNext,
  onUpdateWorkItem,
  onDeleteWorkItem,
  availableMembers,
  availableProjects,
  availableMilestones,
  availableLabels,
  onPendingChangesChange,
  onRegisterActions,
  repoPath,
  projectSlug,
  shortId,
  onRefreshWorkItem,
  onOpenSession,
  onWorkItemNameUpdated,
  onExpandWorkItemToTab,
  breadcrumbProjectName,
  breadcrumbIcon,
  propertiesOpen,
  onToggleProperties,
  publishHeaderToWorkstation,
  workstationHeaderHost,
}) => {
  const handleUpdateWorkItem = useCallback(
    (updates: Partial<WorkItemExtended>) => {
      if (!workItem) return;
      if (updates.name !== undefined) {
        onWorkItemNameUpdated?.(updates.name);
      }
      onUpdateWorkItem(workItem.session_id, updates);
    },
    [onUpdateWorkItem, onWorkItemNameUpdated, workItem]
  );

  const handleExpandToTab = useCallback(
    (pendingUpdates: Partial<WorkItemExtended>) => {
      if (!workItem || !onExpandWorkItemToTab) return;

      onExpandWorkItemToTab(
        workItem.session_id,
        workItem.name || "Work Item",
        Object.keys(pendingUpdates).length > 0
          ? (pendingUpdates as Record<string, unknown>)
          : undefined
      );
      onClose();
    },
    [onClose, onExpandWorkItemToTab, workItem]
  );

  if (!workItem) return null;

  return (
    <Suspense fallback={<Placeholder variant="loading" />}>
      <WorkItemDetail
        workItem={workItem}
        onClose={onClose}
        onNavigate={onNavigate}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onUpdateWorkItem={handleUpdateWorkItem}
        onDeleteWorkItem={onDeleteWorkItem}
        availableMembers={availableMembers}
        availableProjects={availableProjects}
        availableMilestones={availableMilestones}
        availableLabels={availableLabels}
        showTime={true}
        onPendingChangesChange={onPendingChangesChange}
        externalSaveBar={true}
        onRegisterActions={onRegisterActions}
        repoPath={repoPath}
        projectSlug={projectSlug}
        shortId={shortId}
        onRefreshWorkItem={onRefreshWorkItem}
        onOpenSession={onOpenSession}
        onExpandToTab={onExpandWorkItemToTab ? handleExpandToTab : undefined}
        surface={WORK_ITEM_DETAIL_SURFACE.nested}
        breadcrumbProjectName={breadcrumbProjectName}
        breadcrumbIcon={breadcrumbIcon}
        propertiesOpen={propertiesOpen}
        onToggleProperties={onToggleProperties}
        publishHeaderToWorkstation={publishHeaderToWorkstation}
        workstationHeaderHost={workstationHeaderHost}
      />
    </Suspense>
  );
};

export default EmbeddedWorkItemDetail;
