import { createElement, useMemo } from "react";

import type {
  LinearIssueSummary,
  LinearProjectSummary,
  LinearWorkflowStateSummary,
} from "@src/api/http/integrations";
import { CircleIcon, HugeiconsIcon } from "@src/icons";
import type { WorkItemExternalStatusConfig } from "@src/modules/ProjectManager/WorkItems/components/WorkItemProperties/types";
import type { StatusFilterType } from "@src/modules/ProjectManager/WorkItems/types";
import {
  countWorkItemsByStatus,
  filterWorkItemsByStatus,
  getWorkItemNavigation,
  groupWorkItemsForStatusFilter,
} from "@src/modules/ProjectManager/WorkItems/workItemsViewModel";
import type { DropdownOption } from "@src/types/core/shared";
import type { WorkItem } from "@src/types/core/workItem";

import { linearIssueToWorkItem } from "./utils";

interface UseLinearProjectsDerivedStateOptions {
  project: LinearProjectSummary | null;
  issues: LinearIssueSummary[];
  workflowStates: LinearWorkflowStateSummary[];
  statusFilter: StatusFilterType;
  selectedIssueId: string | null;
  loadingWorkflowStates: boolean;
  savingIssue: boolean;
  handleUpdateIssueWorkflowState: (
    issueId: string,
    stateId: string
  ) => Promise<void>;
}

export interface LinearProjectsDerivedState {
  workItems: WorkItem[];
  filteredWorkItems: WorkItem[];
  groupedWorkItems: ReturnType<typeof groupWorkItemsForStatusFilter>;
  statusCounts: ReturnType<typeof countWorkItemsByStatus>;
  navigation: ReturnType<typeof getWorkItemNavigation>;
  selectedWorkItem: WorkItem | null;
  selectedIssue: LinearIssueSummary | null;
  issueStateIdsById: Map<string, string>;
  linearStatusOptions: DropdownOption<string>[];
  linearIssueStatusConfig: WorkItemExternalStatusConfig | undefined;
}

export function useLinearProjectsDerivedState({
  project,
  issues,
  workflowStates,
  statusFilter,
  selectedIssueId,
  loadingWorkflowStates,
  savingIssue,
  handleUpdateIssueWorkflowState,
}: UseLinearProjectsDerivedStateOptions): LinearProjectsDerivedState {
  const workItems = useMemo(
    () =>
      project
        ? issues.map((issue) => linearIssueToWorkItem(issue, project))
        : [],
    [issues, project]
  );

  const filteredWorkItems = useMemo(
    () => filterWorkItemsByStatus(workItems, statusFilter),
    [statusFilter, workItems]
  );

  const groupedWorkItems = useMemo(
    () => groupWorkItemsForStatusFilter(filteredWorkItems, statusFilter),
    [filteredWorkItems, statusFilter]
  );

  const statusCounts = useMemo(
    () => countWorkItemsByStatus(workItems),
    [workItems]
  );

  const navigation = useMemo(
    () => getWorkItemNavigation(filteredWorkItems, selectedIssueId),
    [filteredWorkItems, selectedIssueId]
  );

  const selectedWorkItem = useMemo(
    () =>
      workItems.find((workItem) => workItem.session_id === selectedIssueId) ??
      null,
    [selectedIssueId, workItems]
  );

  const selectedIssue = useMemo(
    () => issues.find((issue) => issue.id === selectedIssueId) ?? null,
    [issues, selectedIssueId]
  );

  const issueStateIdsById = useMemo(() => {
    const stateIds = new Map<string, string>();
    issues.forEach((issue) => {
      if (issue.state?.id) stateIds.set(issue.id, issue.state.id);
    });
    return stateIds;
  }, [issues]);

  const linearStatusOptions = useMemo<DropdownOption<string>[]>(
    () =>
      workflowStates.map((state) => ({
        value: state.id,
        label: state.name,
        color: state.color ?? undefined,
        icon: createElement(HugeiconsIcon, {
          icon: CircleIcon,
          size: 12,
          fill: state.color ?? "#6B7280",
          strokeWidth: 1.5,
        }),
      })),
    [workflowStates]
  );

  const linearIssueStatusConfig = useMemo(() => {
    if (!selectedIssue) return undefined;
    return {
      currentStatusId: selectedIssue.state?.id,
      loading: loadingWorkflowStates,
      disabled: savingIssue,
      options: workflowStates.map((state) => ({
        id: state.id,
        label: state.name,
        color: state.color ?? undefined,
      })),
      onChangeStatusId: (stateId: string) =>
        handleUpdateIssueWorkflowState(selectedIssue.id, stateId),
    };
  }, [
    handleUpdateIssueWorkflowState,
    loadingWorkflowStates,
    savingIssue,
    selectedIssue,
    workflowStates,
  ]);

  return {
    workItems,
    filteredWorkItems,
    groupedWorkItems,
    statusCounts,
    navigation,
    selectedWorkItem,
    selectedIssue,
    issueStateIdsById,
    linearStatusOptions,
    linearIssueStatusConfig,
  };
}
