import { useSetAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  type MemberEntry,
  type WorkItemFrontmatter,
  enrichedWorkItemToUI,
  projectApi,
} from "@src/api/http/project";
import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import {
  ChatPanelHeaderBreadcrumb,
  usePublishChatPanelHeader,
} from "@src/engines/ChatPanel/header";
import KanbanBoard from "@src/features/KanbanBoard";
import type { KanbanTask, TaskStatus } from "@src/features/KanbanBoard";
import { allocateCloudAwareWorkItemId } from "@src/features/Org2Cloud/cloudShortId";
import { createLogger } from "@src/hooks/logger";
import {
  useCurrentUserMemberIds,
  useProjectDataChanged,
} from "@src/hooks/project";
import WorkItemContentStack from "@src/modules/ProjectManager/WorkItems/components/WorkItemContentStack";
import { MultiSelectBar } from "@src/modules/ProjectManager/WorkItems/components/WorkItemsFooterBars";
import WorkItemsListContent from "@src/modules/ProjectManager/WorkItems/components/WorkItemsListContent";
import WorkItemsStatusFilterSelect from "@src/modules/ProjectManager/WorkItems/components/WorkItemsStatusFilterSelect";
import { useMultiSelect } from "@src/modules/ProjectManager/WorkItems/hooks/useMultiSelect";
import {
  type StatusFilterType,
  WORK_ITEMS_DEFAULT_STATUS,
} from "@src/modules/ProjectManager/WorkItems/types";
import {
  WORK_ITEMS_KANBAN_GROUP,
  type WorkItemsKanbanGroup,
  countWorkItemsByStatus,
  filterWorkItemsByStatus,
  getStatusFilterKeysForWorkItems,
  getWorkItemsKanbanColumns,
  groupWorkItemsForStatusFilter,
  workItemsToKanbanTasks,
} from "@src/modules/ProjectManager/WorkItems/workItemsViewModel";
import {
  PROJECT_PROPERTY_CONCISE_FIELDS,
  ProjectContentEditor,
  type ProjectData,
  ProjectPropertyFields,
} from "@src/modules/ProjectManager/shared";
import {
  DetailPanelContainer,
  Placeholder,
} from "@src/modules/shared/layouts/blocks";
import {
  CHAT_PANEL_SURFACE_KIND,
  type ChatPanelSelectedProject,
  chatPanelNavigateAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  STORY_ORG_SCOPE,
  STORY_PERSONAL_ORG_FILTER_ID,
} from "@src/store/workstation";
import type { WorkItem } from "@src/types/core/workItem";

const logger = createLogger("ProjectPanelView");

type ProjectPanelTab = "overview" | "list" | "kanban";

interface ProjectPanelViewProps {
  selectedProject: ChatPanelSelectedProject;
}

const PROJECT_PANEL_TABS: ProjectPanelTab[] = ["overview", "list", "kanban"];

function getProjectOverviewDescription(
  project: ChatPanelSelectedProject["project"]
) {
  const description = project.description?.trim() ?? "";
  return description === project.name.trim() ? "" : description;
}

export const ProjectPanelView: React.FC<ProjectPanelViewProps> = ({
  selectedProject,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const navigateChatPanel = useSetAtom(chatPanelNavigateAtom);
  const sidebarProjectDescription = getProjectOverviewDescription(
    selectedProject.project
  );
  const [activePanelTab, setActivePanelTab] = useState<ProjectPanelTab>("list");
  const [statusFilter, setStatusFilter] = useState<StatusFilterType>("all");
  const [kanbanGroupBy, setKanbanGroupBy] = useState<WorkItemsKanbanGroup>(
    WORK_ITEMS_KANBAN_GROUP.STATUS
  );
  const [projectDescription, setProjectDescription] = useState(
    sidebarProjectDescription
  );
  const [projectBodyLoading, setProjectBodyLoading] = useState(false);
  const [projectBodyError, setProjectBodyError] = useState<string | null>(null);
  const lastSavedDescriptionRef = useRef(sidebarProjectDescription);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [workItemShortIds, setWorkItemShortIds] = useState<Map<string, string>>(
    new Map()
  );
  const [workItemsLoading, setWorkItemsLoading] = useState(false);
  const [workItemsError, setWorkItemsError] = useState<string | null>(null);
  const propertiesRef = useRef<HTMLDivElement>(null);

  const orgPathLabel =
    selectedProject.orgName || t("projects:orgs.personalOrg");
  const projectProperties = useMemo<ProjectData>(
    () => ({
      id: selectedProject.project.id,
      name: selectedProject.project.name,
      description: selectedProject.project.description,
      slug: selectedProject.project.slug,
      workItemPrefix: selectedProject.project.workItemPrefix,
      workItemPrefixCustom: selectedProject.project.workItemPrefixCustom,
      status: selectedProject.project.status,
      priority: selectedProject.project.priority,
      health: selectedProject.project.health,
      lead: selectedProject.project.lead,
      members: selectedProject.project.members,
      teams: selectedProject.project.teams,
      labels: selectedProject.project.labels,
      linkedRepos: selectedProject.project.linkedRepos?.map((repo) => ({
        id: repo.id,
        name: repo.name,
      })),
      startDate: selectedProject.project.startDate,
      targetDate: selectedProject.project.targetDate,
      completionPercentage: selectedProject.project.completionPercentage,
      statusBreakdown: selectedProject.project.statusBreakdown,
    }),
    [selectedProject.project]
  );
  const projectSlug =
    selectedProject.projectSlug || selectedProject.project.slug;
  const repoPath = selectedProject.project.linkedRepos?.[0]?.path ?? null;

  useEffect(() => {
    let cancelled = false;

    if (!projectSlug) {
      setProjectDescription(sidebarProjectDescription);
      lastSavedDescriptionRef.current = sidebarProjectDescription;
      return;
    }

    setProjectBodyLoading(true);
    setProjectBodyError(null);
    void (async () => {
      try {
        const currentProject = await projectApi.readProject(projectSlug);
        if (cancelled) return;
        const nextDescription = currentProject.description.trim();
        setProjectDescription(nextDescription);
        lastSavedDescriptionRef.current = nextDescription;
      } catch (error) {
        if (cancelled) return;
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load project body";
        setProjectBodyError(message);
      } finally {
        if (!cancelled) {
          setProjectBodyLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectSlug, selectedProject.project.id, sidebarProjectDescription]);

  const loadProjectWorkItems = useCallback(async () => {
    if (!projectSlug) {
      setWorkItems([]);
      setWorkItemShortIds(new Map());
      return;
    }

    setWorkItemsLoading(true);
    setWorkItemsError(null);
    try {
      const viewData = await projectApi.readWorkItemsViewData(projectSlug);
      setWorkItemShortIds(
        new Map(viewData.items.map((item) => [item.id, item.shortId]))
      );
      setWorkItems(viewData.items.map(enrichedWorkItemToUI));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load work items";
      logger.error("Failed to load project work items:", error);
      setWorkItemsError(message);
    } finally {
      setWorkItemsLoading(false);
    }
  }, [projectSlug]);

  useEffect(() => {
    void loadProjectWorkItems();
  }, [loadProjectWorkItems]);

  useProjectDataChanged(
    useCallback(() => {
      void loadProjectWorkItems();
    }, [loadProjectWorkItems])
  );

  useEffect(() => {
    if (
      !projectSlug ||
      lastSavedDescriptionRef.current === projectDescription
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          const currentProject = await projectApi.readProject(projectSlug);
          await projectApi.writeProject(
            projectSlug,
            {
              ...currentProject.meta,
              updated_at: new Date().toISOString(),
            },
            projectDescription
          );
          lastSavedDescriptionRef.current = projectDescription;
        } catch (error) {
          logger.error("Failed to save project overview description:", error);
        }
      })();
    }, 500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [projectDescription, projectSlug]);

  const getWorkItemShortId = useCallback(
    (workItemId: string) => workItemShortIds.get(workItemId) ?? null,
    [workItemShortIds]
  );

  const handleDeleteWorkItem = useCallback(
    async (workItemId: string) => {
      if (!projectSlug) return;
      const shortId = getWorkItemShortId(workItemId);
      if (!shortId) return;
      await projectApi.deleteWorkItem(projectSlug, shortId);
      await loadProjectWorkItems();
    },
    [getWorkItemShortId, loadProjectWorkItems, projectSlug]
  );

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
      setStatusFilter("all");
    }
  }, [statusFilter, statusFilterKeys]);

  const filteredWorkItems = useMemo(
    () => filterWorkItemsByStatus(workItems, statusFilter),
    [statusFilter, workItems]
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
  const { memberIds: currentUserMemberIds } =
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

  const handleOpenOrg = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      navigateChatPanel({
        kind: CHAT_PANEL_SURFACE_KIND.PROJECT_ORG,
        projectOrg: {
          orgId: selectedProject.orgId,
          orgName: orgPathLabel,
          orgScope:
            selectedProject.orgId === STORY_PERSONAL_ORG_FILTER_ID
              ? STORY_ORG_SCOPE.PERSONAL_ORG
              : STORY_ORG_SCOPE.PROJECT_ORG,
        },
      });
    },
    [navigateChatPanel, orgPathLabel, selectedProject.orgId]
  );

  const handleOpenProjectOverview = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      setActivePanelTab("overview");
    },
    []
  );

  const headerBreadcrumbContent = useMemo(
    () => (
      <ChatPanelHeaderBreadcrumb
        items={[
          {
            key: "org",
            label: orgPathLabel,
            onClick: handleOpenOrg,
          },
          {
            key: "project",
            label: selectedProject.project.name,
            onClick: handleOpenProjectOverview,
          },
        ]}
      />
    ),
    [
      handleOpenOrg,
      handleOpenProjectOverview,
      orgPathLabel,
      selectedProject.project.name,
    ]
  );

  usePublishChatPanelHeader({
    content: { content: headerBreadcrumbContent },
  });

  const inlineProperties = (
    <div ref={propertiesRef}>
      <ProjectPropertyFields
        project={projectProperties}
        containerRef={propertiesRef}
        fieldVariant="pill"
        visibleFields={PROJECT_PROPERTY_CONCISE_FIELDS}
        availableRepos={projectProperties.linkedRepos}
        showMoreMenu
      />
    </div>
  );

  const panelTabItems = PROJECT_PANEL_TABS.map((tab) => ({
    key: tab,
    label:
      tab === "overview"
        ? t("projects:orgs.management.overview")
        : tab === "list"
          ? t("projects:workItems.tabs.list")
          : t("projects:workItems.tabs.kanban"),
  }));
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
      navigateChatPanel({
        kind: CHAT_PANEL_SURFACE_KIND.WORK_ITEM,
        workItem: {
          workItem,
          projectId: selectedProject.project.id,
          projectName: selectedProject.project.name,
          projectSlug: projectSlug ?? selectedProject.projectSlug,
          shortId: workItemShortIds.get(workItemId) ?? workItemId,
          orgId: selectedProject.orgId,
          orgName: selectedProject.orgName,
          sourceProject: selectedProject,
        },
      });
    },
    [
      projectSlug,
      selectedProject,
      navigateChatPanel,
      workItemShortIds,
      workItems,
    ]
  );

  const handleSelectWorkItemFromKanban = useCallback(
    (task: KanbanTask) => {
      handleSelectWorkItem(task.id);
    },
    [handleSelectWorkItem]
  );

  const handleUpdateWorkItem = useCallback(
    async (workItemId: string, updates: Partial<WorkItem>) => {
      if (!projectSlug) return;
      const shortId = getWorkItemShortId(workItemId);
      if (!shortId) return;

      const payload = {} as Parameters<
        typeof projectApi.updateWorkItemPartial
      >[2];
      if (updates.name !== undefined) payload.title = updates.name;
      if (updates.spec !== undefined) payload.body = updates.spec;
      if (updates.workItemStatus !== undefined) {
        payload.status = updates.workItemStatus;
      }
      if (updates.priority !== undefined) payload.priority = updates.priority;
      if (Object.keys(payload).length === 0) return;

      const updated = await projectApi.updateWorkItemPartial(
        projectSlug,
        shortId,
        payload
      );
      const updatedItem = enrichedWorkItemToUI(updated);
      setWorkItems((currentItems) =>
        currentItems.map((item) =>
          item.session_id === workItemId ? updatedItem : item
        )
      );
    },
    [getWorkItemShortId, projectSlug]
  );

  const handleAddKanbanTask = useCallback(
    async (status: TaskStatus) => {
      if (!projectSlug) return;
      // Collab-synced orgs allocate on the server (design §16.5) — a local
      // counter here could mint the same PREFIX-n as a teammate and merge
      // two distinct work items on push.
      const shortId = await allocateCloudAwareWorkItemId(projectSlug);
      const now = new Date().toISOString();
      const frontmatter: WorkItemFrontmatter = {
        id: shortId,
        short_id: shortId,
        title: t("projects:workItems.newWorkItemName", {
          defaultValue: "New Work Item",
        }),
        project: selectedProject.project.id,
        status: status || WORK_ITEMS_DEFAULT_STATUS,
        priority: "none",
        labels: [],
        created_at: now,
        updated_at: now,
        starred: false,
        todos: [],
      };
      await projectApi.writeWorkItem(projectSlug, shortId, frontmatter, "");
      await loadProjectWorkItems();
    },
    [loadProjectWorkItems, projectSlug, selectedProject.project.id, t]
  );

  const handleDescriptionChange = useCallback((markdown: string) => {
    setProjectDescription(markdown);
  }, []);

  const overviewContent = projectBodyLoading ? (
    <Placeholder
      variant="loading"
      title={t("common:actions.loading")}
      fillParentHeight
    />
  ) : projectBodyError ? (
    <Placeholder variant="error" title={projectBodyError} fillParentHeight />
  ) : (
    <section data-testid="chat-panel-project-overview-section">
      <ProjectContentEditor
        key={projectSlug}
        title={selectedProject.project.name}
        onTitleChange={() => undefined}
        initialDescription={projectDescription}
        onDescriptionChange={handleDescriptionChange}
        titleVisible={false}
        separatorVisible={false}
        descriptionPlaceholder={t("workItems.overview.descriptionPlaceholder")}
        editable
        descriptionClassName="no-bottom-border"
        repoPath={repoPath}
        className="w-full"
      />
    </section>
  );

  const workItemsContent = workItemsLoading ? (
    <Placeholder
      variant="loading"
      title={t("common:actions.loading")}
      fillParentHeight
    />
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
  ) : (
    <div
      className={
        activePanelTab === "kanban"
          ? "h-full min-h-0 flex-1 overflow-hidden"
          : "overflow-visible"
      }
    >
      {activePanelTab === "kanban" ? (
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
      ) : (
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
          scrollMode="page"
          workItemPrefix={selectedProject.project.workItemPrefix}
        />
      )}
    </div>
  );

  const descriptionContent = (
    <section
      className="flex min-h-0 flex-1 flex-col"
      data-testid="chat-panel-project-section"
    >
      <div className="mb-4 flex shrink-0 items-center justify-between gap-2">
        <TabPill
          tabs={panelTabItems}
          activeTab={activePanelTab}
          onChange={(key) => setActivePanelTab(key as ProjectPanelTab)}
          variant="simple"
          fillWidth={false}
          size="chatPanel"
        />
        {activePanelTab !== "overview" ? (
          <div className="flex shrink-0 items-center gap-1">
            {activePanelTab === "kanban" ? (
              <TabPill
                tabs={kanbanGroupTabs}
                activeTab={kanbanGroupBy}
                onChange={(key) =>
                  setKanbanGroupBy(key as WorkItemsKanbanGroup)
                }
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
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide">
        {activePanelTab === "overview" ? overviewContent : workItemsContent}
      </div>
    </section>
  );

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="chat-panel-project-detail"
    >
      <DetailPanelContainer className="relative">
        <WorkItemContentStack
          propertiesContent={inlineProperties}
          descriptionContent={descriptionContent}
          descriptionFlexible
          descriptionClassName="min-h-0 flex flex-1 flex-col px-4 py-4"
        />
        {activePanelTab !== "overview" ? (
          <MultiSelectBar
            selectedCount={selectedIds.size}
            visibleItemCount={workItems.length}
            deleting={bulkDeleting}
            centeredActions
            onSelectAll={handleSelectAll}
            onUnselectAll={handleUnselectAll}
            onDelete={handleBulkDelete}
          />
        ) : null}
      </DetailPanelContainer>
    </div>
  );
};

export default ProjectPanelView;
