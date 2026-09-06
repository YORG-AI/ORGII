import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import DetailPaneLayout, {
  DetailPanePlaceholder,
} from "@src/modules/shared/layouts/DetailPaneLayout";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import type { WorkItem } from "@src/types/core/workItem";

import { useWorkItems } from "../../hooks/useWorkItems";
import { isDeletedWorkItem } from "../../workItemsViewModel";
import RevisionConflictModal from "../RevisionConflictModal";
import WorkItemDetail from "../WorkItemDetail";
import {
  getAdjacentWorkItemId,
  getWorkItemNavigationState,
  resolveProjectScopedOrgId,
} from "./model";
import type { WorkItemDetailPageProps } from "./types";

export function ProjectScopedWorkItemDetailPage({
  projectId,
  projectName,
  projectSlug,
  orgId,
  workItemId,
  onClose,
  onOpenChatSession,
  pendingUpdates,
  publishHeaderToWorkstation = false,
  onWorkItemNameUpdated,
  onWorkItemStatusResolved,
}: WorkItemDetailPageProps) {
  const { t } = useTranslation("projects");
  const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);
  const [activeWorkItemId, setActiveWorkItemId] = useState(workItemId);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const { data, projectData, handlers } = useWorkItems({
    projectId: projectId ?? "",
    cachedProjectSlug: projectSlug,
  });

  useEffect(() => {
    setActiveWorkItemId(workItemId);
  }, [workItemId]);

  useEffect(() => {
    if (data.workItems.length > 0) {
      handlers.handleSelect(activeWorkItemId);
    }
  }, [activeWorkItemId, data.workItems.length, handlers]);

  const workItem = useMemo(
    () =>
      data.workItems.find((item) => item.session_id === activeWorkItemId) ??
      null,
    [activeWorkItemId, data.workItems]
  );
  const workItemDeleted = workItem ? isDeletedWorkItem(workItem) : false;

  useEffect(() => {
    const workItemStatus = workItem?.workItemStatus ?? workItem?.status;
    if (workItemStatus) onWorkItemStatusResolved?.(workItemStatus);
  }, [onWorkItemStatusResolved, workItem]);
  const navigation = useMemo(
    () => getWorkItemNavigationState(data.workItems, activeWorkItemId),
    [activeWorkItemId, data.workItems]
  );

  const handleNavigate = useCallback(
    (direction: "prev" | "next") => {
      const adjacentId = getAdjacentWorkItemId(
        data.workItems,
        navigation.index,
        direction
      );
      if (adjacentId) setActiveWorkItemId(adjacentId);
    },
    [data.workItems, navigation.index]
  );

  const handleDelete = useCallback(
    async (itemId: string) => {
      await handlers.handleDelete(itemId);
      onClose();
    },
    [handlers, onClose]
  );
  const handleUpdateWorkItem = useCallback(
    (updates: Partial<WorkItem>) => {
      handlers.handleUpdate(activeWorkItemId, updates);
    },
    [activeWorkItemId, handlers]
  );

  useEffect(() => {
    if (workItem?.name !== undefined) {
      onWorkItemNameUpdated?.(workItem.name);
    }
  }, [onWorkItemNameUpdated, workItem?.name]);

  useEffect(() => {
    if (workItemDeleted) onClose();
  }, [onClose, workItemDeleted]);

  if (!workItem || workItemDeleted) {
    return (
      <DetailPaneLayout>
        <DetailPanePlaceholder
          variant={projectData.loading ? "loading" : "empty"}
          title={projectData.loading ? undefined : t("workItems.noWorkItems")}
        />
      </DetailPaneLayout>
    );
  }

  return (
    <>
      <WorkItemDetail
        workItem={workItem}
        onClose={onClose}
        onNavigate={handleNavigate}
        hasPrev={navigation.hasPrev}
        hasNext={navigation.hasNext}
        onUpdateWorkItem={handleUpdateWorkItem}
        onDeleteWorkItem={handleDelete}
        availableMembers={projectData.availableMembers}
        availableProjects={projectData.availableProjects}
        availableMilestones={projectData.availableMilestones}
        availableLabels={projectData.availableLabels}
        showTime
        repoPath={activeWorkspaceRootPath || null}
        projectSlug={projectData.project?.slug ?? null}
        orgId={resolveProjectScopedOrgId(projectData.project?.orgId, orgId)}
        shortId={data.getShortId(workItem.session_id) ?? null}
        onRefreshWorkItem={data.refresh}
        onOpenSession={onOpenChatSession}
        initialPendingUpdates={pendingUpdates as Partial<WorkItem> | undefined}
        breadcrumbProjectName={projectName ?? undefined}
        propertiesOpen={propertiesOpen}
        onToggleProperties={() => setPropertiesOpen((current) => !current)}
        publishHeaderToWorkstation={publishHeaderToWorkstation}
      />
      <RevisionConflictModal
        conflict={
          data.revisionConflict
            ? {
                fieldLabel: t(
                  data.revisionConflict.field === "title"
                    ? "workItems.revisionConflict.titleField"
                    : "workItems.revisionConflict.descriptionField"
                ),
                mine: data.revisionConflict.mine,
                latest: data.revisionConflict.latest,
                expectedRevision: data.revisionConflict.expectedRevision,
                actualRevision: data.revisionConflict.actualRevision,
              }
            : null
        }
        onUseLatest={data.useLatestRevisionConflict}
        onKeepMine={data.keepMineRevisionConflict}
      />
    </>
  );
}
