/**
 * useProjectWorkItemsTabContentInteractions
 *
 * Owns work-item selection state, Kanban task/column derivation, and the
 * row/task mutation handlers (select, update, move, bulk delete) for
 * ProjectWorkItemsTabContent. Extracted to keep the tab-content component
 * under the 600-line limit.
 */
import { emit } from "@tauri-apps/api/event";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useMemo, useState } from "react";

import {
  type MemberEntry,
  enrichedWorkItemToUI,
  projectApi,
} from "@src/api/http/project";
import type { KanbanTask, TaskStatus } from "@src/features/KanbanBoard";
import { useCurrentUserMemberIds } from "@src/hooks/project";
import type { LinearProjectSelection } from "@src/modules/ProjectManager/Panels/ProjectManagerSidebar/content/WorkspaceTreeContent";
import { applyWorkItemUpdate } from "@src/modules/ProjectManager/WorkItems/workItemSource";
import {
  WORK_ITEMS_KANBAN_GROUP,
  type WorkItemsKanbanGroup,
  getWorkItemsKanbanColumns,
  workItemsToKanbanTasks,
} from "@src/modules/ProjectManager/WorkItems/workItemsViewModel";
import {
  WORKSPACE_SOURCE,
  type WorkspaceWorkItem,
} from "@src/modules/ProjectManager/workspaceAggregate";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";
import { mapWithConcurrency } from "@src/util/collections/mapWithConcurrency";

import type {
  AggregatedWorkItem,
  ProjectWorkItemSelection,
} from "./ProjectWorkItemsTabContentTypes";

interface UseProjectWorkItemsTabContentInteractionsParams {
  workItems: WorkspaceWorkItem[];
  workItemsByProject: AggregatedWorkItem[];
  setWorkItemsByProject: Dispatch<SetStateAction<AggregatedWorkItem[]>>;
  filteredWorkItems: WorkspaceWorkItem[];
  projectOptions: Array<{
    id: string;
    name: string;
    slug: string;
    orgId: string;
    orgName?: string;
  }>;
  kanbanGroupBy: WorkItemsKanbanGroup;
  loadWorkItems: (cancelled?: () => boolean) => Promise<void>;
  onOpenLinearProject?: (selection: LinearProjectSelection) => void;
  onOpenWorkItem: (selection: ProjectWorkItemSelection) => void;
  onCreateWorkItem?: () => void;
  t: (key: string) => string;
}

export function useProjectWorkItemsTabContentInteractions({
  workItems,
  workItemsByProject,
  setWorkItemsByProject,
  filteredWorkItems,
  projectOptions,
  kanbanGroupBy,
  loadWorkItems,
  onOpenLinearProject,
  onOpenWorkItem,
  onCreateWorkItem,
  t,
}: UseProjectWorkItemsTabContentInteractionsParams) {
  const [selectedWorkItemIds, setSelectedWorkItemIds] = useState<Set<string>>(
    new Set()
  );
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const workItemPeople = useMemo<MemberEntry[]>(() => {
    const people = new Map<string, MemberEntry>();
    for (const workItem of workItems) {
      for (const person of [workItem.assignee, workItem.createdBy]) {
        if (!person) continue;
        people.set(person.id, {
          id: person.id,
          name: person.name,
          avatar: person.avatar,
          active: true,
        });
      }
    }
    return [...people.values()];
  }, [workItems]);
  const { currentUser, memberIds: currentUserMemberIds } =
    useCurrentUserMemberIds(workItemPeople);
  const pinnedKanbanColumnIds = useMemo(
    () => [...currentUserMemberIds].map((memberId) => `person:${memberId}`),
    [currentUserMemberIds]
  );

  const kanbanTasks = useMemo<KanbanTask[]>(
    () => workItemsToKanbanTasks(filteredWorkItems, kanbanGroupBy),
    [filteredWorkItems, kanbanGroupBy]
  );
  const kanbanColumns = useMemo(
    () =>
      getWorkItemsKanbanColumns(
        filteredWorkItems,
        kanbanGroupBy,
        t("workItems.properties.noAssignee"),
        pinnedKanbanColumnIds
      ),
    [filteredWorkItems, kanbanGroupBy, pinnedKanbanColumnIds, t]
  );

  const selectableFilteredWorkItemCount = useMemo(
    () =>
      filteredWorkItems.filter(
        (workItem) =>
          workItem.workspaceSource?.source !== WORKSPACE_SOURCE.LINEAR
      ).length,
    [filteredWorkItems]
  );

  const workItemById = useMemo(() => {
    const map = new Map<string, AggregatedWorkItem>();
    for (const workItem of workItemsByProject) {
      map.set(workItem.item.session_id, workItem);
    }
    return map;
  }, [workItemsByProject]);

  const handleSelectWorkItem = useCallback(
    (workItemId: string) => {
      const workItem = workItemById.get(workItemId);
      if (!workItem) return;
      if (
        workItem.item.workspaceSource?.source === WORKSPACE_SOURCE.LINEAR &&
        onOpenLinearProject
      ) {
        onOpenLinearProject({
          connectionId: workItem.item.workspaceSource.connectionId,
          projectId: workItem.item.workspaceSource.projectId,
          projectName: workItem.item.workspaceSource.projectName,
          teamId: workItem.item.workspaceSource.teamId,
          teamName: workItem.item.workspaceSource.teamName,
        });
        return;
      }
      onOpenWorkItem({
        workItem: workItem.item,
        shortId: workItem.shortId,
        orgId: workItem.orgId,
        orgName: workItem.orgName,
        projectId: workItem.project?.meta.id,
        projectName: workItem.project?.meta.name,
        projectSlug: workItem.project?.slug,
      });
    },
    [workItemById, onOpenLinearProject, onOpenWorkItem]
  );

  const handleUpdateWorkItem = useCallback(
    async (workItemId: string, updates: Partial<WorkItemExtended>) => {
      const entry = workItemById.get(workItemId);
      if (!entry?.project?.slug) return;
      if (entry.item.workspaceSource?.source === WORKSPACE_SOURCE.LINEAR)
        return;

      if ("project" in updates) {
        const targetProject = updates.project
          ? projectOptions.find((project) => project.id === updates.project?.id)
          : null;
        if (!targetProject || targetProject.slug === entry.project.slug) return;
        await projectApi.moveWorkItem(
          entry.item.session_id,
          entry.project.slug,
          targetProject.slug
        );
        setWorkItemsByProject((currentEntries) =>
          currentEntries.map((currentEntry) =>
            currentEntry.item.session_id === workItemId
              ? {
                  ...currentEntry,
                  project: {
                    meta: {
                      id: targetProject.id,
                      name: targetProject.name,
                    },
                    slug: targetProject.slug,
                  },
                  orgId: targetProject.orgId,
                  orgName: targetProject.orgName,
                  item: {
                    ...currentEntry.item,
                    project: {
                      id: targetProject.id,
                      name: targetProject.name,
                    },
                  },
                }
              : currentEntry
          )
        );
        return;
      }

      const updated = await applyWorkItemUpdate(
        entry.project.slug,
        entry.item.session_id,
        updates,
        currentUser
      );
      if (!updated) return;
      const updatedItem = {
        ...enrichedWorkItemToUI(updated),
        project: entry.item.project,
      };
      setWorkItemsByProject((currentEntries) =>
        currentEntries.map((currentEntry) =>
          currentEntry.item.session_id === workItemId
            ? { ...currentEntry, item: updatedItem }
            : currentEntry
        )
      );
    },
    [currentUser, projectOptions, workItemById, setWorkItemsByProject]
  );

  const handleKanbanTaskMove = useCallback(
    (taskId: string, newStatus: TaskStatus) => {
      if (kanbanGroupBy !== WORK_ITEMS_KANBAN_GROUP.STATUS) return;
      void handleUpdateWorkItem(taskId, {
        workItemStatus: newStatus as WorkItemExtended["workItemStatus"],
      });
    },
    [handleUpdateWorkItem, kanbanGroupBy]
  );

  const handleKanbanTaskClick = useCallback(
    (task: KanbanTask) => {
      handleSelectWorkItem(task.id);
    },
    [handleSelectWorkItem]
  );

  const handleAddKanbanTask = useCallback(
    (_status: TaskStatus) => {
      onCreateWorkItem?.();
    },
    [onCreateWorkItem]
  );

  const handleRefresh = useCallback(() => {
    void loadWorkItems();
  }, [loadWorkItems]);

  const handleCheckedChange = useCallback(
    (workItemId: string, checked: boolean) => {
      setSelectedWorkItemIds((previous) => {
        const next = new Set(previous);
        if (checked) {
          next.add(workItemId);
        } else {
          next.delete(workItemId);
        }
        return next;
      });
    },
    []
  );

  const handleSelectAll = useCallback(() => {
    setSelectedWorkItemIds(
      new Set(
        filteredWorkItems
          .filter(
            (workItem) =>
              workItem.workspaceSource?.source !== WORKSPACE_SOURCE.LINEAR
          )
          .map((workItem) => workItem.session_id)
      )
    );
  }, [filteredWorkItems]);

  const handleUnselectAll = useCallback(() => {
    setSelectedWorkItemIds(new Set());
  }, []);

  const handleBulkDelete = useCallback(async () => {
    const selectedLocalEntries = [...selectedWorkItemIds]
      .map((workItemId) => workItemById.get(workItemId))
      .filter(
        (entry): entry is AggregatedWorkItem =>
          !!entry &&
          entry.item.workspaceSource?.source !== WORKSPACE_SOURCE.LINEAR
      );
    if (selectedLocalEntries.length === 0) return;

    setBulkDeleting(true);
    try {
      const entriesByProjectSlug = new Map<string, string[]>();
      for (const entry of selectedLocalEntries) {
        if (!entry.project?.slug) continue;
        const currentShortIds =
          entriesByProjectSlug.get(entry.project.slug) ?? [];
        currentShortIds.push(entry.item.session_id);
        entriesByProjectSlug.set(entry.project.slug, currentShortIds);
      }

      await mapWithConcurrency(
        [...entriesByProjectSlug],
        4,
        ([projectSlug, shortIds]) =>
          projectApi.batchDeleteWorkItems(projectSlug, shortIds)
      );
      await emit("orgii-data-changed");
      setSelectedWorkItemIds(new Set());
      await loadWorkItems();
    } finally {
      setBulkDeleting(false);
    }
  }, [loadWorkItems, selectedWorkItemIds, workItemById]);

  return {
    kanbanTasks,
    kanbanColumns,
    workItemPeople,
    selectableFilteredWorkItemCount,
    selectedWorkItemIds,
    bulkDeleting,
    handleSelectWorkItem,
    handleUpdateWorkItem,
    handleKanbanTaskMove,
    handleKanbanTaskClick,
    handleAddKanbanTask,
    handleRefresh,
    handleCheckedChange,
    handleSelectAll,
    handleUnselectAll,
    handleBulkDelete,
  };
}
