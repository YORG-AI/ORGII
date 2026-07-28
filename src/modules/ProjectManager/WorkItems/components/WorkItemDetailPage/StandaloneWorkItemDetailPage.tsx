import { useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { projectApi, workItemDataToUI } from "@src/api/http/project";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import type { WorkItem } from "@src/types/core/workItem";

import WorkItemDetail from "../WorkItemDetail";
import { applyStandaloneWorkItemUpdates } from "./model";
import type { WorkItemDetailPageProps } from "./types";

const EMPTY_RELATION_MAPS = {
  labelMap: new Map(),
  memberMap: new Map(),
  projectNameMap: new Map(),
};

export function StandaloneWorkItemDetailPage({
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
  const [workItem, setWorkItem] = useState<WorkItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [propertiesOpen, setPropertiesOpen] = useState(true);

  const loadWorkItem = useCallback(async () => {
    setLoading(true);
    try {
      const item = await projectApi.readStandaloneWorkItem(workItemId);
      setWorkItem(workItemDataToUI(item, EMPTY_RELATION_MAPS));
    } finally {
      setLoading(false);
    }
  }, [workItemId]);

  useEffect(() => {
    void loadWorkItem();
  }, [loadWorkItem]);

  useEffect(() => {
    const workItemStatus = workItem?.workItemStatus ?? workItem?.status;
    if (workItemStatus) onWorkItemStatusResolved?.(workItemStatus);
  }, [onWorkItemStatusResolved, workItem]);

  const handleUpdateWorkItem = useCallback(
    async (updates: Partial<WorkItem>) => {
      if (!workItem) return;
      if (updates.name !== undefined) {
        onWorkItemNameUpdated?.(updates.name);
      }
      const current = await projectApi.readStandaloneWorkItem(workItemId);
      await projectApi.writeStandaloneWorkItem(
        workItemId,
        applyStandaloneWorkItemUpdates(current.frontmatter, updates),
        updates.spec ?? current.body
      );
      await loadWorkItem();
    },
    [loadWorkItem, onWorkItemNameUpdated, workItem, workItemId]
  );

  if (!workItem) {
    return (
      <Placeholder
        variant={loading ? "loading" : "empty"}
        placement="detail-panel"
        title={loading ? undefined : t("workItems.noWorkItems")}
        fillParentHeight
      />
    );
  }

  return (
    <WorkItemDetail
      workItem={workItem}
      onClose={onClose}
      onNavigate={() => undefined}
      hasPrev={false}
      hasNext={false}
      onUpdateWorkItem={handleUpdateWorkItem}
      onDeleteWorkItem={onClose}
      availableMembers={[]}
      availableProjects={[]}
      availableMilestones={[]}
      availableLabels={[]}
      showTime
      repoPath={activeWorkspaceRootPath || null}
      projectSlug={null}
      shortId={workItemId}
      onRefreshWorkItem={loadWorkItem}
      onOpenSession={onOpenChatSession}
      initialPendingUpdates={pendingUpdates as Partial<WorkItem> | undefined}
      propertiesOpen={propertiesOpen}
      onToggleProperties={() => setPropertiesOpen((current) => !current)}
      publishHeaderToWorkstation={publishHeaderToWorkstation}
    />
  );
}
