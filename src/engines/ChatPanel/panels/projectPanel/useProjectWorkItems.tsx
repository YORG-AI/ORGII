import type { TFunction } from "i18next";
import { useSetAtom } from "jotai";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { MemberEntry } from "@src/api/http/project";
import Button from "@src/components/Button";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { Placeholder } from "@src/components/Placeholder";
import TabPill, { type TabPillItem } from "@src/components/TabPill";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { ChatLoadingBlock } from "@src/engines/ChatPanel/blocks/primitives";
import KanbanBoard, {
  type KanbanTask,
  type TaskStatus,
} from "@src/features/KanbanBoard";
import { useCurrentUserMemberIds } from "@src/hooks/project";
import { HugeiconsIcon, Search01Icon } from "@src/icons";
import { MultiSelectBar } from "@src/modules/ProjectManager/WorkItems/components/WorkItemsFooterBars";
import WorkItemsListContent from "@src/modules/ProjectManager/WorkItems/components/WorkItemsListContent";
import WorkItemsStatusFilterSelect from "@src/modules/ProjectManager/WorkItems/components/WorkItemsStatusFilterSelect";
import { useMultiSelect } from "@src/modules/ProjectManager/WorkItems/hooks/useMultiSelect";
import { useProjectWorkItemsSource } from "@src/modules/ProjectManager/WorkItems/hooks/useProjectWorkItemsSource";
import {
  type StatusFilterType,
  WORK_ITEMS_DEFAULT_STATUS,
} from "@src/modules/ProjectManager/WorkItems/types";
import {
  WORK_ITEMS_KANBAN_GROUP,
  type WorkItemsKanbanGroup,
  countWorkItemsByStatus,
  filterWorkItemsBySearchQuery,
  filterWorkItemsByStatus,
  getStatusFilterKeysForWorkItems,
  getWorkItemsKanbanColumns,
  groupWorkItemsForStatusFilter,
  workItemsToKanbanTasks,
} from "@src/modules/ProjectManager/WorkItems/workItemsViewModel";
import { ContentSearchPalette } from "@src/scaffold/GlobalSpotlight/palettes";
import { openWorkItemInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { ChatPanelSelectedProject } from "@src/store/ui/chatPanelAtom";
import type { WorkItem } from "@src/types/core/workItem";

import { resolveChatPanelShortcutOwnership } from "../../hooks/chatPanelShortcutOwnership";
import type { ProjectPanelTab } from "./types";

/** Owns the work-item surface; query/mutation storage belongs to ProjectManager. */
export function useProjectWorkItems(
  selectedProject: ChatPanelSelectedProject,
  activePanelTab: ProjectPanelTab,
  panelRef: RefObject<HTMLDivElement | null>,
  t: TFunction<["projects", "common"]>
) {
  const openWorkItemTab = useSetAtom(openWorkItemInChatPanelTabAtom);
  const projectSlug =
    selectedProject.projectSlug || selectedProject.project.slug;
  const [statusFilter, setStatusFilter] = useState<StatusFilterType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [kanbanGroupBy, setKanbanGroupBy] = useState<WorkItemsKanbanGroup>(
    WORK_ITEMS_KANBAN_GROUP.STATUS
  );
  const paneOwnsSearchShortcutRef = useRef(true);
  const {
    workItems,
    workItemShortIds,
    workItemsLoading,
    workItemsError,
    loadProjectWorkItems,
    getWorkItemShortId,
    handleDeleteWorkItem,
    updateWorkItem,
    createWorkItem,
  } = useProjectWorkItemsSource(projectSlug);

  useEffect(() => {
    const updatePaneOwnership = (target: EventTarget | null) => {
      paneOwnsSearchShortcutRef.current = resolveChatPanelShortcutOwnership(
        panelRef.current,
        target,
        paneOwnsSearchShortcutRef.current
      );
    };
    const handlePointerDown = (event: PointerEvent) => {
      updatePaneOwnership(event.target);
    };
    const handleFocusIn = (event: FocusEvent) => {
      updatePaneOwnership(event.target);
    };

    updatePaneOwnership(document.activeElement);
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("focusin", handleFocusIn, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("focusin", handleFocusIn, true);
    };
  }, [panelRef]);

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if (
        activePanelTab === "overview" ||
        event.key.toLowerCase() !== "f" ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }

      if (!isSearchOpen && !paneOwnsSearchShortcutRef.current) return;

      event.preventDefault();
      event.stopPropagation();
      setIsSearchOpen(true);
    };

    window.addEventListener("keydown", handleSearchShortcut, true);
    return () =>
      window.removeEventListener("keydown", handleSearchShortcut, true);
  }, [activePanelTab, isSearchOpen]);

  const statusCounts = useMemo(
    () => countWorkItemsByStatus(workItems),
    [workItems]
  );

  const statusFilterKeys = useMemo(
    () => getStatusFilterKeysForWorkItems(workItems),
    [workItems]
  );
  useEffect(() => {
    if (!statusFilterKeys.includes(statusFilter)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Preserve the pane's existing reset after its available statuses change.
      setStatusFilter("all");
    }
  }, [statusFilter, statusFilterKeys]);

  const filteredWorkItems = useMemo(
    () =>
      filterWorkItemsBySearchQuery(
        filterWorkItemsByStatus(workItems, statusFilter),
        searchQuery
      ),
    [searchQuery, statusFilter, workItems]
  );

  const groupedWorkItems = useMemo(
    () => groupWorkItemsForStatusFilter(filteredWorkItems, statusFilter),
    [filteredWorkItems, statusFilter]
  );

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
        t("projects:workItems.properties.noAssignee"),
        pinnedKanbanColumnIds
      ),
    [filteredWorkItems, kanbanGroupBy, pinnedKanbanColumnIds, t]
  );

  const {
    selectedIds,
    bulkDeleting,
    handleCheckedChange,
    handleSelectAll,
    handleUnselectAll,
    handleBulkDelete,
  } = useMultiSelect({
    filteredWorkItems,
    onDelete: handleDeleteWorkItem,
    projectSlug,
    getShortId: getWorkItemShortId,
    onBatchDeleteComplete: loadProjectWorkItems,
  });

  const kanbanGroupTabs = useMemo<TabPillItem[]>(
    () => [
      {
        key: WORK_ITEMS_KANBAN_GROUP.STATUS,
        label: t("projects:projects.groupBy.status"),
      },
      {
        key: WORK_ITEMS_KANBAN_GROUP.ASSIGNED_TO,
        label: t("projects:projects.groupBy.assignedTo"),
      },
      {
        key: WORK_ITEMS_KANBAN_GROUP.CREATED_BY,
        label: t("projects:projects.groupBy.createdBy"),
      },
    ],
    [t]
  );

  const handleSelectWorkItem = useCallback(
    (workItemId: string) => {
      const workItem = workItems.find((item) => item.session_id === workItemId);
      if (!workItem) return;
      openWorkItemTab({
        workItem,
        projectId: selectedProject.project.id,
        projectName: selectedProject.project.name,
        projectSlug: projectSlug ?? selectedProject.projectSlug,
        shortId: workItemShortIds.get(workItemId) ?? workItemId,
        orgId: selectedProject.orgId,
        orgName: selectedProject.orgName,
        sourceProject: selectedProject,
      });
    },
    [projectSlug, selectedProject, openWorkItemTab, workItemShortIds, workItems]
  );

  const handleSelectWorkItemFromKanban = useCallback(
    (task: KanbanTask) => {
      handleSelectWorkItem(task.id);
    },
    [handleSelectWorkItem]
  );

  const handleUpdateWorkItem = useCallback(
    (workItemId: string, updates: Partial<WorkItem>) =>
      updateWorkItem(workItemId, updates, currentUser),
    [currentUser, updateWorkItem]
  );

  const handleAddKanbanTask = useCallback(
    async (status: TaskStatus) => {
      await createWorkItem({
        title: t("projects:workItems.newWorkItemName", {
          defaultValue: "New Work Item",
        }),
        projectId: selectedProject.project.id,
        status: status || WORK_ITEMS_DEFAULT_STATUS,
      });
    },
    [createWorkItem, selectedProject.project.id, t]
  );

  const workItemsUnavailableContent = workItemsLoading ? (
    <div className="p-2">
      <ChatLoadingBlock />
    </div>
  ) : workItemsError ? (
    <Placeholder
      variant="error"
      title={workItemsError}
      fillParentHeight
      action={{
        label: t("common:actions.retry"),
        onClick: loadProjectWorkItems,
      }}
    />
  ) : null;

  const listContent = workItemsUnavailableContent ?? (
    <div className="h-full min-h-0 flex-1 overflow-hidden">
      <WorkItemsListContent
        groupedWorkItems={groupedWorkItems}
        filteredWorkItems={filteredWorkItems}
        workItems={workItems}
        selectedWorkItemId={null}
        availableMembers={selectedProject.project.members ?? []}
        availableProjects={[
          {
            id: selectedProject.project.id,
            name: selectedProject.project.name,
          },
        ]}
        availableLabels={selectedProject.project.labels ?? []}
        checkedWorkItemIds={selectedIds}
        onCheckedChange={handleCheckedChange}
        onSelectWorkItem={handleSelectWorkItem}
        readonly
        disableProjectEdit
        compactRows
        workItemPrefix={selectedProject.project.workItemPrefix}
      />
    </div>
  );

  const kanbanContent = workItemsUnavailableContent ?? (
    <div className="h-full min-h-0 flex-1 overflow-hidden">
      <div className="h-full min-h-0">
        <KanbanBoard
          tasks={kanbanTasks}
          columnOrder={kanbanColumns}
          allowColumnReorder={false}
          allowTaskDrag={kanbanGroupBy === WORK_ITEMS_KANBAN_GROUP.STATUS}
          onTaskMove={(taskId: string, newStatus: TaskStatus) => {
            if (kanbanGroupBy !== WORK_ITEMS_KANBAN_GROUP.STATUS) return;
            void handleUpdateWorkItem(taskId, {
              workItemStatus: newStatus as WorkItem["workItemStatus"],
            });
          }}
          onTaskClick={handleSelectWorkItemFromKanban}
          onAddTask={(status: TaskStatus) => {
            void handleAddKanbanTask(status);
          }}
          showAddButton={kanbanGroupBy === WORK_ITEMS_KANBAN_GROUP.STATUS}
          className="kanban-board--linear"
        />
      </div>
    </div>
  );

  const headerControls = useMemo(
    () => (
      <>
        <ToolbarTooltip
          label={t("common:actions.search")}
          shortcutId="workitems_search"
        >
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            className={
              searchQuery ? "bg-surface-selected! text-primary-6!" : ""
            }
            onClick={() => setIsSearchOpen(true)}
            aria-label={t("common:actions.search")}
            aria-pressed={Boolean(searchQuery)}
            icon={
              <HugeiconsIcon
                icon={Search01Icon}
                data-icon="search"
                size={HEADER_ICON_SIZE.sm}
              />
            }
          />
        </ToolbarTooltip>
        {activePanelTab === "kanban" ? (
          <TabPill
            tabs={kanbanGroupTabs}
            activeTab={kanbanGroupBy}
            onChange={(key) => setKanbanGroupBy(key as WorkItemsKanbanGroup)}
            variant="pill"
            color="fill"
            fillWidth={false}
            size="small"
          />
        ) : null}
        <WorkItemsStatusFilterSelect
          value={statusFilter}
          onChange={setStatusFilter}
          statusCounts={statusCounts}
          filterKeys={statusFilterKeys}
        />
      </>
    ),
    [
      activePanelTab,
      kanbanGroupBy,
      kanbanGroupTabs,
      searchQuery,
      statusCounts,
      statusFilter,
      statusFilterKeys,
      t,
    ]
  );

  return {
    count: workItems.length,
    listContent,
    kanbanContent,
    headerControls,
    searchPalette: (
      <ContentSearchPalette
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        query={searchQuery}
        onQueryChange={setSearchQuery}
        placeholder={t("common:actions.search")}
      />
    ),
    footer: (
      <MultiSelectBar
        selectedCount={selectedIds.size}
        visibleItemCount={workItems.length}
        deleting={bulkDeleting}
        centeredActions
        onSelectAll={handleSelectAll}
        onUnselectAll={handleUnselectAll}
        onDelete={handleBulkDelete}
      />
    ),
  };
}
