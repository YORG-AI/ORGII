/**
 * useLinearIndexData
 *
 * Handles the "index" view of LinearProjectsPage — before a specific project
 * is selected. Responsibilities:
 *   - Discover the default Linear connection id (when none is provided as prop)
 *   - Load all projects (and all issues when surface === "work-items")
 *   - Expose groupMode state and derived Project groupings for the projects list
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  STORY_SYNC_ADAPTER,
  linearProjectsApi,
  syncConnectionsApi,
} from "@src/api/http/integrations";
import type { LinearProjectSummary } from "@src/api/http/integrations";
import type { SelectOption } from "@src/components/Select";
import {
  CircleIcon,
  Flag01Icon,
  HugeiconsIcon,
  TimeScheduleIcon,
} from "@src/icons";
import type { StatusFilterType } from "@src/modules/ProjectManager/WorkItems/types";
import {
  countWorkItemsByStatus,
  filterWorkItemsByStatus,
  groupWorkItemsForStatusFilter,
} from "@src/modules/ProjectManager/WorkItems/workItemsViewModel";
import {
  STORY_STATUS_OPTIONS,
  getProjectPriorityConfig,
  getProjectStatusConfig,
} from "@src/modules/ProjectManager/config/manage";
import type {
  Project,
  ProjectPriority,
  ProjectStatus,
} from "@src/types/core/project";
import type { WorkItem } from "@src/types/core/workItem";
import { mapWithConcurrency } from "@src/util/collections/mapWithConcurrency";

import { cachedLinearProjectsApi } from "./linearProjectsCache";
import {
  errorMessage,
  linearIssueToWorkItem,
  workItemUpdatesToLinearIssueUpdate,
} from "./utils";

// ============================================
// Types
// ============================================

export type LinearProjectsGroupMode = "status" | "priority" | "targetDate";

export interface LinearProjectGroup {
  key: string;
  label: string;
  icon: React.ReactNode;
  color: string;
  projects: Project[];
}

const STORY_PRIORITY_ORDER: ProjectPriority[] = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
];

const TARGET_DATE_GROUPS = [
  "overdue",
  "thisWeek",
  "thisMonth",
  "later",
  "noTargetDate",
] as const;

type TargetDateGroup = (typeof TARGET_DATE_GROUPS)[number];

// ============================================
// Helpers (pure)
// ============================================

function getStartOfToday(): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getTargetDateGroup(project: Project): TargetDateGroup {
  if (!project.targetDate) return "noTargetDate";
  const targetDate = new Date(project.targetDate);
  if (Number.isNaN(targetDate.getTime())) return "noTargetDate";
  const today = getStartOfToday();
  const weekEnd = addDays(today, 7);
  const monthEnd = addDays(today, 30);
  if (targetDate < today) return "overdue";
  if (targetDate <= weekEnd) return "thisWeek";
  if (targetDate <= monthEnd) return "thisMonth";
  return "later";
}

function getProjectStatusLabelKey(status: ProjectStatus): string {
  if (status === "in_progress") return "properties.statusOptions.inProgress";
  return `properties.statusOptions.${status}`;
}

const SECTION_BASE_CONFIG = getProjectStatusConfig("planned");
const LINEAR_PROJECT_ISSUE_CONCURRENCY = 4;

// ============================================
// Hook
// ============================================

interface UseLinearIndexDataOptions {
  /** Explicit connection id passed in as prop — skips auto-discovery. */
  connectionId: string | undefined;
  projectId: string | undefined;
  surface: "projects" | "work-items";
  teamId: string | undefined;
  isActive: boolean;
}

export interface LinearIndexData {
  effectiveConnectionId: string | undefined;
  loadingConnections: boolean;
  connectionLoadError: string | null;

  indexProjects: LinearProjectSummary[];
  indexWorkItems: WorkItem[];
  indexLoading: boolean;
  indexLoaded: boolean;
  indexError: string | null;
  indexStatusFilter: StatusFilterType;
  setIndexStatusFilter: (filter: StatusFilterType) => void;
  indexStatusCounts: ReturnType<typeof countWorkItemsByStatus>;
  indexFilteredWorkItems: WorkItem[];
  indexGroupedWorkItems: ReturnType<typeof groupWorkItemsForStatusFilter>;

  linearProjectsGroupMode: LinearProjectsGroupMode;
  linearProjectsGroupModeOptions: SelectOption[];
  handleLinearProjectsGroupModeChange: (
    value: string | number | (string | number)[]
  ) => void;
  groupedIndexProjects: LinearProjectGroup[];
  indexProjectRows: Project[];

  handleIndexRefresh: () => void;
  handleUpdateIndexWorkItem: (
    workItemId: string,
    updates: Partial<WorkItem>
  ) => Promise<void>;
  indexUpdateError: string | null;
}

export function useLinearIndexData({
  connectionId,
  projectId,
  surface,
  teamId,
  isActive,
}: UseLinearIndexDataOptions): LinearIndexData {
  const { t } = useTranslation(["projects", "common"]);

  // ---- Connection discovery ----
  const [defaultConnectionId, setDefaultConnectionId] = useState<string | null>(
    null
  );
  const [loadingConnections, setLoadingConnections] = useState(false);
  const [connectionLoadError, setConnectionLoadError] = useState<string | null>(
    null
  );

  useEffect(() => {
    if (!isActive || connectionId) return;

    let cancelled = false;
    setLoadingConnections(true);
    setConnectionLoadError(null);
    syncConnectionsApi
      .list()
      .then((connections) => {
        if (cancelled) return;
        const linearConnection = connections.find(
          (connection) => connection.adapter_id === STORY_SYNC_ADAPTER.LINEAR
        );
        setDefaultConnectionId(linearConnection?.id ?? null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setDefaultConnectionId(null);
        setConnectionLoadError(message);
      })
      .finally(() => {
        if (!cancelled) setLoadingConnections(false);
      });

    return () => {
      cancelled = true;
    };
  }, [connectionId, isActive]);

  const effectiveConnectionId =
    connectionId ?? defaultConnectionId ?? undefined;

  // ---- Index data (projects + optional issues) ----
  const [indexProjects, setIndexProjects] = useState<LinearProjectSummary[]>(
    []
  );
  const [indexWorkItems, setIndexWorkItems] = useState<WorkItem[]>([]);
  const [indexLoading, setIndexLoading] = useState(false);
  const [indexLoaded, setIndexLoaded] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [indexStatusFilter, setIndexStatusFilter] =
    useState<StatusFilterType>("all");

  const loadIndexData = useCallback(
    async (
      cancelled?: () => boolean,
      options: { forceRefresh?: boolean } = {}
    ) => {
      if (!effectiveConnectionId || projectId) return;

      setIndexLoading(true);
      setIndexLoaded(false);
      setIndexError(null);
      try {
        const projectsResult = await cachedLinearProjectsApi.listProjects(
          effectiveConnectionId,
          { forceRefresh: options.forceRefresh }
        );
        if (cancelled?.()) return;
        const visibleProjects = teamId
          ? projectsResult.projects.filter((linearProject) =>
              linearProject.teams.some((team) => team.id === teamId)
            )
          : projectsResult.projects;
        setIndexProjects(visibleProjects);

        if (surface === "work-items") {
          const issueResults = await mapWithConcurrency(
            visibleProjects,
            LINEAR_PROJECT_ISSUE_CONCURRENCY,
            (linearProject) =>
              cachedLinearProjectsApi.listProjectIssues(
                effectiveConnectionId,
                linearProject.id,
                { forceRefresh: options.forceRefresh }
              )
          );
          if (cancelled?.()) return;
          setIndexWorkItems(
            issueResults.flatMap((result, resultIndex) => {
              const linearProject = visibleProjects[resultIndex];
              return result.issues.map((issue) =>
                linearIssueToWorkItem(issue, linearProject)
              );
            })
          );
          return;
        }

        setIndexWorkItems([]);
      } catch (error: unknown) {
        if (cancelled?.()) return;
        setIndexProjects([]);
        setIndexWorkItems([]);
        setIndexError(
          errorMessage(error, t("linearProjects.errors.loadProjects"))
        );
      } finally {
        if (!cancelled?.()) {
          setIndexLoaded(true);
          setIndexLoading(false);
        }
      }
    },
    [effectiveConnectionId, projectId, surface, teamId, t]
  );

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    void loadIndexData(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [isActive, loadIndexData]);

  const handleIndexRefresh = useCallback(() => {
    void loadIndexData(undefined, { forceRefresh: true });
  }, [loadIndexData]);

  const [indexUpdateError, setIndexUpdateError] = useState<string | null>(null);

  const handleUpdateIndexWorkItem = useCallback(
    async (workItemId: string, updates: Partial<WorkItem>) => {
      if (!effectiveConnectionId || updates.priority === undefined) return;
      const request = workItemUpdatesToLinearIssueUpdate(
        { priority: updates.priority },
        []
      );
      if (Object.keys(request).length === 0) return;

      try {
        const updatedIssue = await linearProjectsApi.updateIssue(
          effectiveConnectionId,
          workItemId,
          request
        );
        if (updatedIssue.project?.id) {
          cachedLinearProjectsApi.invalidateProjectIssues(
            effectiveConnectionId,
            updatedIssue.project.id
          );
        }
        setIndexWorkItems((currentItems) =>
          currentItems.map((currentItem) => {
            if (currentItem.session_id !== workItemId) return currentItem;
            const parentProject = indexProjects.find(
              (linearProject) => linearProject.id === currentItem.project?.id
            );
            if (!parentProject) return currentItem;
            return linearIssueToWorkItem(updatedIssue, parentProject);
          })
        );
      } catch (err) {
        setIndexUpdateError(
          errorMessage(err, t("linearProjects.errors.updateIssue"))
        );
      }
    },
    [effectiveConnectionId, indexProjects, t]
  );

  // ---- Index work item derived views ----
  const indexStatusCounts = useMemo(
    () => countWorkItemsByStatus(indexWorkItems),
    [indexWorkItems]
  );
  const indexFilteredWorkItems = useMemo(
    () => filterWorkItemsByStatus(indexWorkItems, indexStatusFilter),
    [indexStatusFilter, indexWorkItems]
  );
  const indexGroupedWorkItems = useMemo(
    () =>
      groupWorkItemsForStatusFilter(indexFilteredWorkItems, indexStatusFilter),
    [indexFilteredWorkItems, indexStatusFilter]
  );

  // ---- Group mode for the projects list ----
  const [linearProjectsGroupMode, setLinearProjectsGroupMode] =
    useState<LinearProjectsGroupMode>("status");

  const linearProjectsGroupModeOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: "status",
        label: (
          <span className="flex items-center gap-2 whitespace-nowrap">
            <HugeiconsIcon
              icon={CircleIcon}
              data-icon="circle"
              size={13}
              strokeWidth={1.75}
            />
            <span>{t("projects.groupBy.status")}</span>
          </span>
        ),
        triggerLabel: t("projects.groupBy.status"),
      },
      {
        value: "priority",
        label: (
          <span className="flex items-center gap-2 whitespace-nowrap">
            <HugeiconsIcon
              icon={Flag01Icon}
              data-icon="flag"
              size={13}
              strokeWidth={1.75}
            />
            <span>{t("projects.groupBy.priority")}</span>
          </span>
        ),
        triggerLabel: t("projects.groupBy.priority"),
      },
      {
        value: "targetDate",
        label: (
          <span className="flex items-center gap-2 whitespace-nowrap">
            <HugeiconsIcon
              icon={TimeScheduleIcon}
              data-icon="calendar-clock"
              size={13}
              strokeWidth={1.75}
            />
            <span>{t("projects.groupBy.targetDate")}</span>
          </span>
        ),
        triggerLabel: t("projects.groupBy.targetDate"),
      },
    ],
    [t]
  );

  const handleLinearProjectsGroupModeChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value)) return;
      setLinearProjectsGroupMode(value as LinearProjectsGroupMode);
    },
    []
  );

  // ---- Grouped Linear project rows ----
  const indexProjectRows = useMemo<Project[]>(
    () =>
      indexProjects.map((linearProject) => ({
        id: linearProject.id,
        name: linearProject.name,
        slug: linearProject.slug_id ?? linearProject.id,
        description: linearProject.description ?? "",
        status: getProjectStatusForLinearProject(linearProject),
        priority: "none" as ProjectPriority,
        health: "on_track",
        targetDate: linearProject.target_date,
        createdAt: linearProject.created_at ?? "",
        updatedAt: linearProject.updated_at ?? "",
        workItemCount: undefined,
      })),
    [indexProjects]
  );

  const groupedIndexProjects = useMemo<LinearProjectGroup[]>(() => {
    if (linearProjectsGroupMode === "status") {
      const groups = new Map<ProjectStatus, Project[]>();
      for (const statusOption of STORY_STATUS_OPTIONS) {
        groups.set(statusOption.value, []);
      }
      for (const project of indexProjectRows) {
        groups.get(project.status)?.push(project);
      }
      return STORY_STATUS_OPTIONS.map((statusOption) => ({
        key: statusOption.value,
        label: t(getProjectStatusLabelKey(statusOption.value)),
        icon: statusOption.icon,
        color: statusOption.color,
        projects: groups.get(statusOption.value) ?? [],
      }));
    }

    if (linearProjectsGroupMode === "targetDate") {
      const groups = new Map<TargetDateGroup, Project[]>();
      for (const group of TARGET_DATE_GROUPS) {
        groups.set(group, []);
      }
      for (const project of indexProjectRows) {
        groups.get(getTargetDateGroup(project))?.push(project);
      }
      return TARGET_DATE_GROUPS.map((group) => ({
        key: group,
        label: t(`projects.targetDateGroups.${group}`),
        icon: (
          <HugeiconsIcon
            icon={TimeScheduleIcon}
            data-icon="calendar-clock"
            size={14}
            strokeWidth={1.75}
          />
        ),
        color: SECTION_BASE_CONFIG.color,
        projects: groups.get(group) ?? [],
      }));
    }

    const groups = new Map<ProjectPriority, Project[]>();
    for (const priority of STORY_PRIORITY_ORDER) {
      groups.set(priority, []);
    }
    for (const project of indexProjectRows) {
      groups.get(project.priority)?.push(project);
    }
    return STORY_PRIORITY_ORDER.map((priority) => {
      const priorityConfig = getProjectPriorityConfig(priority);
      return {
        key: priority,
        label: t(`properties.priorityOptions.${priority}`),
        icon: priorityConfig.icon,
        color: priorityConfig.color,
        projects: groups.get(priority) ?? [],
      };
    });
  }, [indexProjectRows, linearProjectsGroupMode, t]);

  return {
    effectiveConnectionId,
    loadingConnections,
    connectionLoadError,

    indexProjects,
    indexWorkItems,
    indexLoading,
    indexLoaded,
    indexError,
    indexStatusFilter,
    setIndexStatusFilter,
    indexStatusCounts,
    indexFilteredWorkItems,
    indexGroupedWorkItems,

    linearProjectsGroupMode,
    linearProjectsGroupModeOptions,
    handleLinearProjectsGroupModeChange,
    groupedIndexProjects,
    indexProjectRows,

    handleIndexRefresh,
    handleUpdateIndexWorkItem,
    indexUpdateError,
  };
}

// ============================================
// Private helpers (used above)
// ============================================

const LINEAR_PROJECT_STATUS_TYPE_TO_STORY_STATUS: Record<
  string,
  ProjectStatus
> = {
  backlog: "backlog",
  planned: "planned",
  unstarted: "planned",
  started: "in_progress",
  active: "in_progress",
  completed: "completed",
  done: "completed",
  canceled: "canceled",
  cancelled: "canceled",
};

function getProjectStatusForLinearProject(
  project: LinearProjectSummary
): ProjectStatus {
  if (project.archived_at) return "completed";
  const linearStatus = project.status?.type;
  return (
    LINEAR_PROJECT_STATUS_TYPE_TO_STORY_STATUS[linearStatus ?? ""] ?? "backlog"
  );
}
