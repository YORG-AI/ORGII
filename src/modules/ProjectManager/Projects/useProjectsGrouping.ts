/**
 * useProjectsGrouping
 *
 * Derives grouped project lists from a flat filtered list and a group mode.
 * Extracted to keep Projects/index.tsx under the 600-line limit.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon, TimeScheduleIcon } from "@src/icons";
import {
  STORY_STATUS_OPTIONS,
  getProjectPriorityConfig,
} from "@src/modules/ProjectManager/config/manage";
import type { WorkspaceProject } from "@src/modules/ProjectManager/workspaceAggregate";
import type { ProjectPriority, ProjectStatus } from "@src/types/core/project";

import {
  type ProjectsGroupMode,
  STORY_PRIORITY_ORDER,
  TARGET_DATE_GROUPS,
  type TargetDateGroup,
  getProjectStatusLabelKey,
  getTargetDateGroup,
} from "./projectsUtils";

export interface ProjectGroup {
  key: string;
  label: string;
  icon: React.ReactNode;
  color: string;
  projects: WorkspaceProject[];
}

interface UseProjectsGroupingOptions {
  filteredProjects: WorkspaceProject[];
  groupMode: ProjectsGroupMode;
}

export function useProjectsGrouping({
  filteredProjects,
  groupMode,
}: UseProjectsGroupingOptions): ProjectGroup[] {
  const { t } = useTranslation("projects");

  return useMemo<ProjectGroup[]>(() => {
    if (groupMode === "status") {
      const groups = new Map<ProjectStatus, WorkspaceProject[]>();
      for (const statusOption of STORY_STATUS_OPTIONS) {
        groups.set(statusOption.value, []);
      }
      for (const project of filteredProjects) {
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

    if (groupMode === "targetDate") {
      const groups = new Map<TargetDateGroup, WorkspaceProject[]>();
      for (const group of TARGET_DATE_GROUPS) {
        groups.set(group, []);
      }
      for (const project of filteredProjects) {
        groups.get(getTargetDateGroup(project))?.push(project);
      }
      return TARGET_DATE_GROUPS.map((group) => ({
        key: group,
        label: t(`projects.targetDateGroups.${group}`),
        icon: React.createElement(HugeiconsIcon, {
          icon: TimeScheduleIcon,
          size: 14,
          strokeWidth: 1.75,
        }),
        color:
          group === "overdue"
            ? "rgb(var(--danger-6))"
            : group === "noTargetDate"
              ? "var(--color-text-4)"
              : "rgb(var(--primary-6))",
        projects: groups.get(group) ?? [],
      }));
    }

    const groups = new Map<ProjectPriority, WorkspaceProject[]>();
    for (const priority of STORY_PRIORITY_ORDER) {
      groups.set(priority, []);
    }
    for (const project of filteredProjects) {
      groups.get(project.priority)?.push(project);
    }
    return STORY_PRIORITY_ORDER.map((priority) => {
      const priorityConfig = getProjectPriorityConfig(priority);
      return {
        key: priority,
        label:
          priority === "none"
            ? t("projects.priorityGroups.unprioritized")
            : t(`properties.priorityOptions.${priority}`),
        icon: priorityConfig.icon,
        color: priorityConfig.color,
        projects: groups.get(priority) ?? [],
      };
    });
  }, [filteredProjects, groupMode, t]);
}
