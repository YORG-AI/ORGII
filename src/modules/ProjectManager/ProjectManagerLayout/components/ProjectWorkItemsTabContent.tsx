import { emit } from "@tauri-apps/api/event";
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
  type WorkItemPartialUpdate,
  enrichedWorkItemToUI,
  projectApi,
  workItemDataToUI,
} from "@src/api/http/project";
import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import KanbanBoard from "@src/features/KanbanBoard";
import type { KanbanTask, TaskStatus } from "@src/features/KanbanBoard";
import {
  useCurrentUserMemberIds,
  useProjectDataChanged,
} from "@src/hooks/project";
import type { WorkstationTabHeaderHost } from "@src/hooks/workStation";
import type { LinearProjectSelection } from "@src/modules/ProjectManager/Panels/ProjectManagerSidebar/content/WorkspaceTreeContent";
import { MultiSelectBar } from "@src/modules/ProjectManager/WorkItems/components/WorkItemsFooterBars";
import WorkItemsListSurface from "@src/modules/ProjectManager/WorkItems/components/WorkItemsListSurface";
import WorkItemsPageHeader from "@src/modules/ProjectManager/WorkItems/components/WorkItemsPageHeader";
import type {
  StatusCounts,
  StatusFilterType,
} from "@src/modules/ProjectManager/WorkItems/types";
import {
  WORK_ITEMS_KANBAN_GROUP,
  type WorkItemsKanbanGroup,
  countWorkspaceWorkItemsByStatus,
  filterWorkspaceWorkItemsByStatus,
  getWorkItemsKanbanColumns,
  getWorkspaceStatusFilterKeysForWorkItems,
  groupWorkspaceWorkItemsForStatusFilter,
  isWorkspaceCompletedWorkItem,
  workItemsToKanbanTasks,
} from "@src/modules/ProjectManager/WorkItems/workItemsViewModel";
import { useProjectManagerWorkItemsTabBarRegistration } from "@src/modules/ProjectManager/hooks/useProjectManagerWorkItemsTabBarRegistration";
import { PROJECT_MANAGER_PLACEHOLDER_PLACEMENT } from "@src/modules/ProjectManager/shared/placeholderTokens";
import {
  WORKSPACE_SOURCE,
  type WorkspaceWorkItem,
  loadWorkspaceLinearWorkItems,
} from "@src/modules/ProjectManager/workspaceAggregate";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";
import { LatestScopedTask } from "@src/util/core/latestScopedTask";

interface ProjectWorkItemsTabContentProps {
  breadcrumbSegments?: readonly { label: string }[];
  workStationTabId?: string;
  workstationHeaderHost?: WorkstationTabHeaderHost;
  onCreateProject?: () => void;
  onCreateWorkItem?: () => void;
  onOpenLinearProject?: (selection: LinearProjectSelection) => void;
  orgId?: string;
  allowExternalSources?: boolean;
  onOpenWorkItem: (selection: ProjectWorkItemSelection) => void;
  /** Org hub surface pills shown after the breadcrumb (Overview / Projects / …). */
  orgSurfaceControls?: React.ReactNode;
}

interface AggregatedWorkItemProject {
  meta: {
    id: string;
    name: string;
  };
  slug: string;
}

interface AggregatedWorkItem {
  project?: AggregatedWorkItemProject;
  item: WorkspaceWorkItem;
  shortId: string;
  orgId: string;
  orgName?: string;
}

export interface ProjectWorkItemSelection {
  workItem: WorkspaceWorkItem;
  shortId: string;
  orgId: string;
  orgName?: string;
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
}

type WorkspaceSourceMode = "local_only" | "include_external";
type ProjectWorkItemsViewTab = "List" | "Kanban";

const STORY_WORK_ITEMS_VISIBLE_TABS = ["List", "Kanban"] as const;
const WORKSPACE_ACTIVE_READ_BUCKET = "active";
const WORKSPACE_COMPLETED_READ_BUCKET = "completed";
const WORKSPACE_DEFAULT_COLLAPSED_STATUSES = ["completed"] as const;

type WorkspaceProjectRecord = Awaited<
  ReturnType<typeof projectApi.readProjects>
>[number];

interface ReadWorkspaceBucketOptions {
  projects: WorkspaceProjectRecord[];
  orgNameById: Map<string, string>;
  orgId?: string;
  readBucket:
    | typeof WORKSPACE_ACTIVE_READ_BUCKET
    | typeof WORKSPACE_COMPLETED_READ_BUCKET;
  linearWorkItems: WorkspaceWorkItem[];
}

async function readWorkspaceBucket({
  projects,
  orgNameById,
  orgId,
  readBucket,
  linearWorkItems,
}: ReadWorkspaceBucketOptions): Promise<AggregatedWorkItem[]> {
  const [localEntryGroups, standaloneWorkItems] = await Promise.all([
    Promise.all(
      projects.map(async (project) => {
        const projectWorkItems = await projectApi.readWorkItemsEnriched(
          project.slug,
          { orgId, readBucket }
        );
        return projectWorkItems.map((workItem) => ({
          project,
          shortId: workItem.shortId,
          orgId: project.meta.org_id,
          orgName: orgNameById.get(project.meta.org_id),
          item: {
            ...enrichedWorkItemToUI(workItem),
            project: {
              id: project.meta.id,
              name: project.meta.name,
            },
          },
        }));
      })
    ),
    projectApi.readStandaloneWorkItems({ orgId, readBucket }),
  ]);
  const standaloneOrgId = orgId ?? "personal-org";
  const standaloneEntries = standaloneWorkItems.map((workItem) => ({
    shortId: workItem.frontmatter.short_id ?? workItem.frontmatter.id,
    orgId: standaloneOrgId,
    orgName: orgNameById.get(standaloneOrgId),
    item: workItemDataToUI(workItem, {
      labelMap: new Map(),
      memberMap: new Map(),
      projectNameMap: new Map(),
    }),
  }));
  const isCompletedBucket = readBucket === WORKSPACE_COMPLETED_READ_BUCKET;
  const linearEntries = linearWorkItems
    .filter(
      (workItem) => isWorkspaceCompletedWorkItem(workItem) === isCompletedBucket
    )
    .map((workItem) => ({
      project: {
        meta: {
          id: workItem.workspaceSource?.projectId ?? "linear",
          name: workItem.workspaceSource?.projectName ?? "Linear",
        },
        slug: workItem.workspaceSource?.projectId ?? "linear",
      },
      shortId: workItem.session_id,
      orgId: "",
      item: workItem,
    }));

  return [...localEntryGroups.flat(), ...standaloneEntries, ...linearEntries];
}

function mergeWorkspaceEntries(
  currentEntries: AggregatedWorkItem[],
  nextEntries: AggregatedWorkItem[]
): AggregatedWorkItem[] {
  const entriesById = new Map(
    currentEntries.map((entry) => [entry.item.session_id, entry])
  );
  for (const entry of nextEntries) {
    entriesById.set(entry.item.session_id, entry);
  }
  return [...entriesById.values()];
}

export const ProjectWorkItemsTabContent: React.FC<
  ProjectWorkItemsTabContentProps
> = ({
  breadcrumbSegments,
  workStationTabId,
  workstationHeaderHost = "project",
  onCreateProject,
  onCreateWorkItem,
  onOpenLinearProject,
  orgId,
  allowExternalSources = false,
  onOpenWorkItem,
  orgSurfaceControls,
}) => {
  const { t } = useTranslation("projects");
  const [workItemsByProject, setWorkItemsByProject] = useState<
    AggregatedWorkItem[]
  >([]);
  const [projectOptions, setProjectOptions] = useState<
    Array<{
      id: string;
      name: string;
      slug: string;
      orgId: string;
      orgName?: string;
    }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const loadWorkItemsCoordinator = useMemo(() => new LatestScopedTask(), []);
  const completedItemsLoadedRef = useRef(false);
  const completedSectionExpandedRef = useRef(false);
  const [completedItemsLoading, setCompletedItemsLoading] = useState(false);
  const completedItemsLoadingRef = useRef(false);
  const completedLoadGenerationRef = useRef(0);
  const [completedItemsError, setCompletedItemsError] = useState<string | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [activeViewTab, setActiveViewTab] =
    useState<ProjectWorkItemsViewTab>("List");
  const [statusFilter, setStatusFilter] = useState<StatusFilterType>("all");
  const [kanbanGroupBy, setKanbanGroupBy] = useState<WorkItemsKanbanGroup>(
    WORK_ITEMS_KANBAN_GROUP.STATUS
  );
  const [collapseAllSignal, setCollapseAllSignal] = useState(0);
  const [selectedWorkItemIds, setSelectedWorkItemIds] = useState<Set<string>>(
    new Set()
  );
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [workspaceSourceMode, setWorkspaceSourceMode] =
    useState<WorkspaceSourceMode>("local_only");

  const includeExternalSources =
    allowExternalSources && workspaceSourceMode === "include_external";

  useEffect(() => {
    if (!allowExternalSources) {
      setWorkspaceSourceMode("local_only");
    }
  }, [allowExternalSources]);

  useEffect(() => {
    completedLoadGenerationRef.current += 1;
    completedItemsLoadedRef.current = false;
    completedItemsLoadingRef.current = false;
    setCompletedItemsLoading(false);
    setCompletedItemsError(null);
  }, [includeExternalSources, orgId]);

  const loadWorkItems = useCallback(async () => {
    const scopeKey = JSON.stringify([orgId ?? null, includeExternalSources]);
    await loadWorkItemsCoordinator.run(scopeKey, async (context) => {
      setLoading(true);
      setError(null);
      try {
        const [projects, orgs, linearWorkItems] = await Promise.all([
          projectApi.readProjects({ orgId }),
          projectApi.readOrgs(),
          includeExternalSources ? loadWorkspaceLinearWorkItems() : [],
        ]);
        const orgNameById = new Map(orgs.map((org) => [org.id, org.name]));
        const shouldLoadCompleted =
          completedItemsLoadedRef.current ||
          completedSectionExpandedRef.current;
        const [activeEntries, completedEntries] = await Promise.all([
          readWorkspaceBucket({
            projects,
            orgNameById,
            orgId,
            readBucket: WORKSPACE_ACTIVE_READ_BUCKET,
            linearWorkItems,
          }),
          shouldLoadCompleted
            ? readWorkspaceBucket({
                projects,
                orgNameById,
                orgId,
                readBucket: WORKSPACE_COMPLETED_READ_BUCKET,
                linearWorkItems,
              })
            : Promise.resolve([]),
        ]);
        if (!context.isCurrent()) return;
        setProjectOptions(
          projects.map((project) => ({
            id: project.meta.id,
            name: project.meta.name,
            slug: project.slug,
            orgId: project.meta.org_id,
            orgName: orgNameById.get(project.meta.org_id),
          }))
        );
        setWorkItemsByProject((currentEntries) => {
          if (shouldLoadCompleted) {
            return [...activeEntries, ...completedEntries];
          }
          const completedEntriesToPreserve = completedItemsLoadedRef.current
            ? currentEntries.filter((entry) =>
                isWorkspaceCompletedWorkItem(entry.item)
              )
            : [];
          return [...activeEntries, ...completedEntriesToPreserve];
        });
        if (shouldLoadCompleted) {
          completedItemsLoadedRef.current = true;
        }
        loadedRef.current = true;
        setLoaded(true);
      } catch (err) {
        if (!context.isCurrent()) return;
        if (!loadedRef.current) {
          setWorkItemsByProject([]);
        }
        setError(
          err instanceof Error ? err.message : t("projects.loadProjectsFailed")
        );
      } finally {
        if (context.isCurrent()) setLoading(false);
      }
    });
  }, [includeExternalSources, loadWorkItemsCoordinator, orgId, t]);

  useEffect(() => {
    void loadWorkItems();
    return () => {
      loadWorkItemsCoordinator.supersede();
    };
  }, [loadWorkItems, loadWorkItemsCoordinator]);

  useProjectDataChanged(
    useCallback(() => {
      void loadWorkItems();
    }, [loadWorkItems])
  );

  const loadCompletedWorkItems = useCallback(async () => {
    if (completedItemsLoadedRef.current || completedItemsLoadingRef.current) {
      return;
    }

    completedItemsLoadingRef.current = true;
    const loadGeneration = completedLoadGenerationRef.current + 1;
    completedLoadGenerationRef.current = loadGeneration;
    setCompletedItemsLoading(true);
    setCompletedItemsError(null);
    try {
      const [projects, orgs, linearWorkItems] = await Promise.all([
        projectApi.readProjects({ orgId }),
        projectApi.readOrgs(),
        includeExternalSources ? loadWorkspaceLinearWorkItems() : [],
      ]);
      const orgNameById = new Map(orgs.map((org) => [org.id, org.name]));
      const completedEntries = await readWorkspaceBucket({
        projects,
        orgNameById,
        orgId,
        readBucket: WORKSPACE_COMPLETED_READ_BUCKET,
        linearWorkItems,
      });
      if (completedLoadGenerationRef.current !== loadGeneration) return;
      setWorkItemsByProject((currentEntries) =>
        mergeWorkspaceEntries(currentEntries, completedEntries)
      );
      completedItemsLoadedRef.current = true;
    } catch (err) {
      if (completedLoadGenerationRef.current === loadGeneration) {
        setCompletedItemsError(
          err instanceof Error ? err.message : t("projects.loadProjectsFailed")
        );
      }
    } finally {
      if (completedLoadGenerationRef.current === loadGeneration) {
        completedItemsLoadingRef.current = false;
        setCompletedItemsLoading(false);
      }
    }
  }, [includeExternalSources, orgId, t]);

  useEffect(() => {
    if (statusFilter === "done" || statusFilter === "closed") {
      void loadCompletedWorkItems();
    }
  }, [loadCompletedWorkItems, statusFilter]);

  const workItems = useMemo(
    () => workItemsByProject.map((entry) => entry.item),
    [workItemsByProject]
  );

  const availableProjects = useMemo(
    () => projectOptions.map(({ id, name }) => ({ id, name })),
    [projectOptions]
  );

  const statusCounts = useMemo<StatusCounts>(
    () => countWorkspaceWorkItemsByStatus(workItems),
    [workItems]
  );

  const statusFilterKeys = useMemo(
    () => getWorkspaceStatusFilterKeysForWorkItems(workItems),
    [workItems]
  );
  useEffect(() => {
    if (!statusFilterKeys.includes(statusFilter)) {
      setStatusFilter("all");
    }
  }, [statusFilter, statusFilterKeys]);

  const filteredWorkItems = useMemo(
    () => filterWorkspaceWorkItemsByStatus(workItems, statusFilter),
    [statusFilter, workItems]
  );

  const groupedWorkItems = useMemo(
    () => groupWorkspaceWorkItemsForStatusFilter(workItems, statusFilter),
    [statusFilter, workItems]
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

      const payload: WorkItemPartialUpdate = {};
      if (updates.name !== undefined) payload.title = updates.name;
      if (updates.spec !== undefined) payload.body = updates.spec;
      if (updates.workItemStatus !== undefined) {
        payload.status = updates.workItemStatus;
      }
      if (updates.priority !== undefined) payload.priority = updates.priority;
      if ("endDate" in updates) payload.targetDate = updates.endDate ?? null;
      if (Object.keys(payload).length === 0) return;

      const updated = await projectApi.updateWorkItemPartial(
        entry.project.slug,
        entry.item.session_id,
        payload
      );
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
    [projectOptions, workItemById]
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

      await Promise.all(
        [...entriesByProjectSlug].map(([projectSlug, shortIds]) =>
          projectApi.batchDeleteWorkItems(projectSlug, shortIds)
        )
      );
      await emit("orgii-data-changed");
      setSelectedWorkItemIds(new Set());
      await loadWorkItems();
    } finally {
      setBulkDeleting(false);
    }
  }, [loadWorkItems, selectedWorkItemIds, workItemById]);

  const handleCollapseAll = useCallback(() => {
    setCollapseAllSignal((currentSignal) => currentSignal + 1);
  }, []);

  const handleSectionExpandedChange = useCallback(
    (sectionStatus: string, expanded: boolean) => {
      if (sectionStatus !== "completed") return;
      completedSectionExpandedRef.current = expanded;
      if (expanded) void loadCompletedWorkItems();
    },
    [loadCompletedWorkItems]
  );

  const renderSectionPlaceholder = useCallback(
    (sectionStatus: string) => {
      if (sectionStatus !== "completed") return undefined;
      if (completedItemsLoading) {
        return (
          <Placeholder
            variant="loading"
            placement="sidebar"
            className="min-h-16"
          />
        );
      }
      if (completedItemsError) {
        return (
          <Placeholder
            variant="error"
            placement="sidebar"
            title={completedItemsError}
            onRetry={() => void loadCompletedWorkItems()}
            className="min-h-16"
          />
        );
      }
      return undefined;
    },
    [completedItemsError, completedItemsLoading, loadCompletedWorkItems]
  );

  const workspaceSourceTabs = useMemo<TabPillItem[]>(
    () => [
      { key: "local_only", label: t("projects.source.localOnly") },
      {
        key: "include_external",
        label: t("projects.source.includeExternal"),
      },
    ],
    [t]
  );

  const workItemsViewTabs = useMemo<TabPillItem[]>(
    () =>
      STORY_WORK_ITEMS_VISIBLE_TABS.map((tab) => ({
        key: tab,
        label: t(`workItems.tabs.${tab === "List" ? "list" : "kanban"}`),
      })),
    [t]
  );
  const kanbanGroupTabs = useMemo<TabPillItem[]>(
    () => [
      {
        key: WORK_ITEMS_KANBAN_GROUP.STATUS,
        label: t("projects.groupBy.status"),
      },
      {
        key: WORK_ITEMS_KANBAN_GROUP.ASSIGNED_TO,
        label: t("projects.groupBy.assignedTo"),
      },
      {
        key: WORK_ITEMS_KANBAN_GROUP.CREATED_BY,
        label: t("projects.groupBy.createdBy"),
      },
    ],
    [t]
  );

  const handleWorkItemsViewChange = useCallback((key: string) => {
    if (key === "List" || key === "Kanban") {
      setActiveViewTab(key);
    }
  }, []);

  const workItemsViewSwitch = useMemo(
    () => (
      <TabPill
        tabs={workItemsViewTabs}
        activeTab={activeViewTab}
        onChange={handleWorkItemsViewChange}
        variant="pill"
        color="fill"
        fillWidth={false}
        size="small"
      />
    ),
    [activeViewTab, handleWorkItemsViewChange, workItemsViewTabs]
  );

  const kanbanGroupSwitch = useMemo(() => {
    if (activeViewTab !== "Kanban") return null;
    return (
      <TabPill
        tabs={kanbanGroupTabs}
        activeTab={kanbanGroupBy}
        onChange={(key) => setKanbanGroupBy(key as WorkItemsKanbanGroup)}
        variant="pill"
        color="fill"
        fillWidth={false}
        size="small"
      />
    );
  }, [activeViewTab, kanbanGroupBy, kanbanGroupTabs]);

  const handleWorkspaceSourceModeChange = useCallback((key: string) => {
    setWorkspaceSourceMode(key as WorkspaceSourceMode);
  }, []);

  const sourceModeSwitch = useMemo(() => {
    if (!allowExternalSources) return null;
    return (
      <TabPill
        tabs={workspaceSourceTabs}
        activeTab={workspaceSourceMode}
        onChange={handleWorkspaceSourceModeChange}
        variant="pill"
        color="fill"
        fillWidth={false}
        size="small"
      />
    );
  }, [
    allowExternalSources,
    handleWorkspaceSourceModeChange,
    workspaceSourceMode,
    workspaceSourceTabs,
  ]);

  const headerLeadingControls = useMemo(
    () => (
      <div className="flex min-w-0 items-center gap-1.5">
        {orgSurfaceControls}
        {orgSurfaceControls && <span className="text-xs text-text-4">/</span>}
        {workItemsViewSwitch}
        {kanbanGroupSwitch && <span className="text-xs text-text-4">/</span>}
        {kanbanGroupSwitch}
        {sourceModeSwitch && (
          <span
            className="pointer-events-none mx-1 h-4 w-px shrink-0 bg-border-2"
            aria-hidden
          />
        )}
        {sourceModeSwitch}
      </div>
    ),
    [
      kanbanGroupSwitch,
      orgSurfaceControls,
      sourceModeSwitch,
      workItemsViewSwitch,
    ]
  );

  useProjectManagerWorkItemsTabBarRegistration({
    workStationTabId,
    showPropertiesActive: false,
    onSearch: null,
    onRefresh: handleRefresh,
    refreshLoading: loading,
    onToggleProperties: null,
    onAddProject: onCreateProject ?? null,
    onAddWorkItem: onCreateWorkItem ?? null,
  });

  if (loading && !loaded) {
    return (
      <Placeholder
        variant="loading"
        placement={PROJECT_MANAGER_PLACEHOLDER_PLACEMENT}
        title={t("projects.loading")}
        fillParentHeight
      />
    );
  }

  if (error && workItems.length === 0) {
    return (
      <Placeholder
        variant="error"
        placement={PROJECT_MANAGER_PLACEHOLDER_PLACEMENT}
        title={error}
        onRetry={handleRefresh}
        fillParentHeight
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <WorkItemsPageHeader
        projectName={t("projects.columns.workItems")}
        breadcrumbSegments={breadcrumbSegments}
        activeTab={activeViewTab}
        statusFilter={statusFilter}
        onStatusFilterChange={(value) =>
          setStatusFilter(value as StatusFilterType)
        }
        statusCounts={statusCounts}
        statusFilterKeys={statusFilterKeys}
        onCollapseAll={handleCollapseAll}
        onAddProject={onCreateProject}
        onAddWorkItem={onCreateWorkItem}
        onRefresh={handleRefresh}
        refreshLoading={loading}
        leadingControls={headerLeadingControls}
        publishToWorkstationHeader={!!workStationTabId}
        workstationHeaderHost={workstationHeaderHost}
      />

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide">
        {activeViewTab === "Kanban" ? (
          <div className="h-full min-h-0">
            <KanbanBoard
              tasks={kanbanTasks}
              columnOrder={kanbanColumns}
              allowColumnReorder={false}
              allowTaskDrag={kanbanGroupBy === WORK_ITEMS_KANBAN_GROUP.STATUS}
              onTaskMove={handleKanbanTaskMove}
              onTaskClick={handleKanbanTaskClick}
              onAddTask={handleAddKanbanTask}
              showAddButton={
                kanbanGroupBy === WORK_ITEMS_KANBAN_GROUP.STATUS &&
                Boolean(onCreateWorkItem)
              }
              className="kanban-board--linear"
            />
          </div>
        ) : (
          <WorkItemsListSurface
            groupedWorkItems={groupedWorkItems}
            filteredWorkItems={filteredWorkItems}
            selectedWorkItem={null}
            selectedWorkItemId={null}
            workItems={workItems}
            availableMembers={[]}
            availableProjects={availableProjects}
            checkedWorkItemIds={selectedWorkItemIds}
            onCheckedChange={handleCheckedChange}
            onSelectWorkItem={handleSelectWorkItem}
            onUpdateWorkItem={handleUpdateWorkItem}
            collapseAllSignal={collapseAllSignal}
            showEmptySections
            defaultCollapsedStatuses={WORKSPACE_DEFAULT_COLLAPSED_STATUSES}
            renderSectionPlaceholder={renderSectionPlaceholder}
            onSectionExpandedChange={handleSectionExpandedChange}
            emptyListPlaceholder={
              <Placeholder
                variant="empty"
                placement={PROJECT_MANAGER_PLACEHOLDER_PLACEMENT}
                title={t("workItems.noWorkItems")}
                subtitle={t("workItems.noWorkItemsSubtitle")}
                action={
                  onCreateWorkItem
                    ? {
                        label: t("workItems.addFirstWorkItem"),
                        onClick: onCreateWorkItem,
                      }
                    : undefined
                }
                fillParentHeight
              />
            }
            hidePropertiesPanel
          />
        )}
      </div>

      <MultiSelectBar
        selectedCount={selectedWorkItemIds.size}
        visibleItemCount={selectableFilteredWorkItemCount}
        deleting={bulkDeleting}
        onSelectAll={handleSelectAll}
        onUnselectAll={handleUnselectAll}
        onDelete={handleBulkDelete}
      />
    </div>
  );
};

export default ProjectWorkItemsTabContent;
