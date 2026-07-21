import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import type { WorkItem } from "@src/types/core/workItem";

import { useWorkItems } from "../../hooks/useWorkItems";
import WorkItemDetail from "../WorkItemDetail";
import { getAdjacentWorkItemId, getWorkItemNavigationState } from "./model";
import type { WorkItemDetailPageProps } from "./types";

export function ProjectScopedWorkItemDetailPage({
  projectId,
  projectName,
  projectSlug,
  workItemId,
  onClose,
  onOpenChatSession,
  pendingUpdates,
  publishHeaderToWorkstation = false,
  onWorkItemNameUpdated,
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
      if (updates.name !== undefined) {
        onWorkItemNameUpdated?.(updates.name);
      }
      handlers.handleUpdate(activeWorkItemId, updates);
    },
    [activeWorkItemId, handlers, onWorkItemNameUpdated]
  );

  if (!workItem) {
    return (
      <Placeholder
        variant={projectData.loading ? "loading" : "empty"}
        placement="detail-panel"
        title={projectData.loading ? undefined : t("workItems.noWorkItems")}
        fillParentHeight
      />
    );
  }

  return (
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
      shortId={data.getShortId(workItem.session_id) ?? null}
      onRefreshWorkItem={data.refresh}
      onOpenSession={onOpenChatSession}
      initialPendingUpdates={pendingUpdates as Partial<WorkItem> | undefined}
      breadcrumbProjectName={projectName ?? undefined}
      propertiesOpen={propertiesOpen}
      onToggleProperties={() => setPropertiesOpen((current) => !current)}
      publishHeaderToWorkstation={publishHeaderToWorkstation}
    />
  );
}
