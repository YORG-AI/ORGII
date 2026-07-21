/**
 * WorkItemDetailPage
 *
 * Standalone full-tab view for a single work item.
 * Loads the project's work items via useWorkItems, finds the target item,
 * and renders WorkItemDetail without the inline split-panel constraints.
 */
import { useAtomValue } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { projectApi, workItemDataToUI } from "@src/api/http/project";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

import { useWorkItems } from "../../hooks/useWorkItems";
import { isDeletedWorkItem } from "../../workItemsViewModel";
import WorkItemDetail, { type WorkItemDetailActions } from "../WorkItemDetail";

interface WorkItemDetailPageProps {
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
  workItemId: string;
  onClose: () => void;
  /** Open an agent session in a chat tab */
  onOpenChatSession?: (sessionId: string, title?: string) => void;
  /** Unsaved changes transferred from the inline detail panel */
  pendingUpdates?: Record<string, unknown>;
  /** Publish page header into the global WorkstationTabHeader. */
  publishHeaderToWorkstation?: boolean;
  /** Notify parent tab system when the work item title changes */
  onWorkItemNameUpdated?: (workItemName: string) => void;
}

const ProjectScopedWorkItemDetailPage: React.FC<WorkItemDetailPageProps> = ({
  projectId,
  projectName,
  projectSlug: tabProjectSlug,
  workItemId,
  onClose,
  onOpenChatSession,
  pendingUpdates,
  publishHeaderToWorkstation = false,
  onWorkItemNameUpdated,
}) => {
  const { t } = useTranslation("projects");
  const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);
  const { data, projectData, handlers } = useWorkItems({
    projectId: projectId ?? "",
    cachedProjectSlug: tabProjectSlug,
  });

  // Auto-select the target work item on mount / when data loads
  useEffect(() => {
    if (data.workItems.length > 0) {
      handlers.handleSelect(workItemId);
    }
  }, [workItemId, data.workItems.length, handlers]);

  const workItem = useMemo(
    () => data.workItems.find((item) => item.session_id === workItemId) ?? null,
    [data.workItems, workItemId]
  );
  const workItemDeleted = workItem ? isDeletedWorkItem(workItem) : false;

  const workItemIndex = useMemo(
    () => data.workItems.findIndex((item) => item.session_id === workItemId),
    [data.workItems, workItemId]
  );

  const hasPrev = workItemIndex > 0;
  const hasNext =
    workItemIndex >= 0 && workItemIndex < data.workItems.length - 1;

  const handleNavigate = useCallback(
    (direction: "prev" | "next") => {
      const nextIndex =
        direction === "prev" ? workItemIndex - 1 : workItemIndex + 1;
      const nextItem = data.workItems[nextIndex];
      if (nextItem) {
        handlers.handleSelect(nextItem.session_id);
      }
    },
    [workItemIndex, data.workItems, handlers]
  );

  const resolvedRepoPath = activeWorkspaceRootPath || null;
  const resolvedProjectSlug = projectData.project?.slug ?? null;

  const shortId = workItem
    ? (data.getShortId(workItem.session_id) ?? null)
    : null;

  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const workItemActionsRef = useRef<WorkItemDetailActions | null>(null);
  const handleRegisterActions = useCallback(
    (actions: WorkItemDetailActions) => {
      workItemActionsRef.current = actions;
    },
    []
  );

  const handleDelete = useCallback(
    async (itemId: string) => {
      await handlers.handleDelete(itemId);
      onClose();
    },
    [handlers, onClose]
  );

  const handleUpdateWorkItem = useCallback(
    (updates: Partial<WorkItemExtended>) => {
      if (updates.name !== undefined) {
        onWorkItemNameUpdated?.(updates.name);
      }
      handlers.handleUpdate(workItemId, updates);
    },
    [handlers, onWorkItemNameUpdated, workItemId]
  );

  useEffect(() => {
    if (workItemDeleted) onClose();
  }, [onClose, workItemDeleted]);

  if (!workItem || workItemDeleted) {
    if (projectData.loading) {
      return (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          fillParentHeight
        />
      );
    }
    return (
      <Placeholder
        variant="empty"
        placement="detail-panel"
        title={t("workItems.noWorkItems")}
        fillParentHeight
      />
    );
  }

  return (
    <WorkItemDetail
      workItem={workItem}
      onClose={onClose}
      onNavigate={handleNavigate}
      hasPrev={hasPrev}
      hasNext={hasNext}
      onUpdateWorkItem={handleUpdateWorkItem}
      onDeleteWorkItem={handleDelete}
      availableMembers={projectData.availableMembers}
      availableProjects={projectData.availableProjects}
      availableMilestones={projectData.availableMilestones}
      availableLabels={projectData.availableLabels}
      showTime={true}
      onRegisterActions={handleRegisterActions}
      repoPath={resolvedRepoPath}
      projectSlug={resolvedProjectSlug}
      shortId={shortId}
      onRefreshWorkItem={data.refresh}
      onOpenSession={onOpenChatSession}
      initialPendingUpdates={
        pendingUpdates as Partial<WorkItemExtended> | undefined
      }
      breadcrumbProjectName={projectName ?? undefined}
      propertiesOpen={propertiesOpen}
      onToggleProperties={() => setPropertiesOpen((prev) => !prev)}
      publishHeaderToWorkstation={publishHeaderToWorkstation}
    />
  );
};

const StandaloneWorkItemDetailPage: React.FC<WorkItemDetailPageProps> = ({
  workItemId,
  onClose,
  onOpenChatSession,
  pendingUpdates,
  publishHeaderToWorkstation = false,
  onWorkItemNameUpdated,
}) => {
  const { t } = useTranslation("projects");
  const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);
  const [workItem, setWorkItem] = useState<WorkItemExtended | null>(null);
  const [loading, setLoading] = useState(true);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const workItemActionsRef = useRef<WorkItemDetailActions | null>(null);

  const loadWorkItem = useCallback(async () => {
    setLoading(true);
    try {
      const item = await projectApi.readStandaloneWorkItem(workItemId);
      setWorkItem(
        workItemDataToUI(item, {
          labelMap: new Map(),
          memberMap: new Map(),
          projectNameMap: new Map(),
        })
      );
    } finally {
      setLoading(false);
    }
  }, [workItemId]);

  useEffect(() => {
    void loadWorkItem();
  }, [loadWorkItem]);

  const handleRegisterActions = useCallback(
    (actions: WorkItemDetailActions) => {
      workItemActionsRef.current = actions;
    },
    []
  );

  const handleUpdateWorkItem = useCallback(
    async (updates: Partial<WorkItemExtended>) => {
      if (!workItem) return;
      if (updates.name !== undefined) {
        onWorkItemNameUpdated?.(updates.name);
      }
      const current = await projectApi.readStandaloneWorkItem(workItemId);
      const frontmatter = { ...current.frontmatter };
      if (updates.name !== undefined) frontmatter.title = updates.name;
      if (updates.workItemStatus !== undefined) {
        frontmatter.status = updates.workItemStatus;
      }
      if (updates.priority !== undefined) {
        frontmatter.priority = updates.priority;
      }
      if ("endDate" in updates) {
        frontmatter.target_date = updates.endDate ?? undefined;
      }
      await projectApi.writeStandaloneWorkItem(
        workItemId,
        frontmatter,
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
      showTime={true}
      onRegisterActions={handleRegisterActions}
      repoPath={activeWorkspaceRootPath || null}
      projectSlug={null}
      shortId={workItemId}
      onRefreshWorkItem={loadWorkItem}
      onOpenSession={onOpenChatSession}
      initialPendingUpdates={
        pendingUpdates as Partial<WorkItemExtended> | undefined
      }
      breadcrumbProjectName={undefined}
      propertiesOpen={propertiesOpen}
      onToggleProperties={() => setPropertiesOpen((prev) => !prev)}
      publishHeaderToWorkstation={publishHeaderToWorkstation}
    />
  );
};

const WorkItemDetailPage: React.FC<WorkItemDetailPageProps> = (props) => {
  if (!props.projectSlug) {
    return <StandaloneWorkItemDetailPage {...props} />;
  }
  return <ProjectScopedWorkItemDetailPage {...props} />;
};

export default WorkItemDetailPage;
