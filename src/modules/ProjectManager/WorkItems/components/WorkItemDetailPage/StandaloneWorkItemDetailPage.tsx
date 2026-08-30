import { useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { projectApi, workItemDataToUI } from "@src/api/http/project";
import { Placeholder } from "@src/components/Placeholder";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import type { WorkItem } from "@src/types/core/workItem";

import WorkItemDetail from "../WorkItemDetail";
import { standaloneWorkItemUpdatesToPartial } from "./model";
import type { WorkItemDetailPageProps } from "./types";

const EMPTY_RELATION_MAPS = {
  labelMap: new Map(),
  memberMap: new Map(),
  projectNameMap: new Map(),
};

const logger = createLogger("StandaloneWorkItemDetailPage");

export function StandaloneWorkItemDetailPage({
  workItemId,
  orgId,
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
      const item = await projectApi.readStandaloneWorkItem(
        workItemId,
        orgId ? { orgId } : undefined
      );
      setWorkItem(workItemDataToUI(item, EMPTY_RELATION_MAPS));
    } catch (error) {
      logger.warn(
        `Failed to read standalone Work Item ${workItemId} in org ${orgId ?? "personal-org"}`,
        error
      );
    } finally {
      setLoading(false);
    }
  }, [orgId, workItemId]);

  // This page is also mounted outside the Workstation renderer. If one of
  // those hosts reuses it for a different identity, clear the previous row
  // once at the identity boundary rather than on every background refresh.
  useEffect(() => {
    setWorkItem(null);
  }, [orgId, workItemId]);

  useEffect(() => {
    void loadWorkItem();
  }, [loadWorkItem]);

  // Linked-session status mirrors, receipt fallbacks, and CLI writes land
  // through the data-changed signal after this tab has mounted. Without a
  // subscription the page keeps its open-time snapshot forever.
  useProjectDataChanged(
    useCallback(
      (change) => {
        if (change?.workItemId && change.workItemId !== workItemId) return;
        void loadWorkItem();
      },
      [loadWorkItem, workItemId]
    )
  );

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
      // Atomic partial update — the read-modify-write happens inside the
      // Rust BEGIN IMMEDIATE transaction, so concurrent edits can't be
      // silently dropped by a client-side merge + whole-row write.
      await projectApi.updateStandaloneWorkItemPartial(
        workItemId,
        standaloneWorkItemUpdatesToPartial(updates, updates.spec),
        orgId ? { orgId } : undefined
      );
      await loadWorkItem();
    },
    [loadWorkItem, onWorkItemNameUpdated, orgId, workItem, workItemId]
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
      orgId={orgId}
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
