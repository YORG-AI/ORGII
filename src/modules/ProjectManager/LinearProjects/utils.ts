import type {
  LinearIssueSummary,
  LinearIssueUpdateRequest,
  LinearProjectSummary,
  LinearWorkflowStateSummary,
} from "@src/api/http/integrations";
import type {
  WorkItem,
  WorkItemPriority,
  WorkItemStatus,
} from "@src/types/core/workItem";

const LINEAR_STATUS_TO_WORK_ITEM_STATUS: Record<
  string,
  WorkItem["workItemStatus"]
> = {
  backlog: "backlog",
  unstarted: "planned",
  started: "in_progress",
  completed: "completed",
  canceled: "cancelled",
};

const WORK_ITEM_STATUS_TO_LINEAR_TYPE: Partial<
  Record<NonNullable<WorkItem["workItemStatus"]>, string>
> = {
  backlog: "backlog",
  planned: "unstarted",
  in_progress: "started",
  in_review: "started",
  blocked: "started",
  completed: "completed",
  cancelled: "canceled",
};

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function linearPriorityToWorkItemPriority(priority?: number): WorkItemPriority {
  if (priority === 1) return "urgent";
  if (priority === 2) return "high";
  if (priority === 3) return "medium";
  if (priority === 4) return "low";
  return "none";
}

function workItemPriorityToLinearPriority(
  priority?: WorkItemPriority
): number | undefined {
  if (priority === "urgent") return 1;
  if (priority === "high") return 2;
  if (priority === "medium") return 3;
  if (priority === "low") return 4;
  if (priority === "none") return 0;
  return undefined;
}

export function workItemStatusForLinearWorkflowState(
  state: Pick<LinearWorkflowStateSummary, "type">
): WorkItemStatus {
  return LINEAR_STATUS_TO_WORK_ITEM_STATUS[state.type ?? ""] ?? "backlog";
}

export function linearWorkflowStateForWorkItemStatus(
  workItemStatus: WorkItem["workItemStatus"],
  workflowStates: LinearWorkflowStateSummary[]
): LinearWorkflowStateSummary | undefined {
  if (!workItemStatus) return undefined;
  const linearType = WORK_ITEM_STATUS_TO_LINEAR_TYPE[workItemStatus];
  return workflowStates.find((state) => state.type === linearType);
}

export function workItemUpdatesToLinearIssueUpdate(
  updates: Partial<WorkItem>,
  workflowStates: LinearWorkflowStateSummary[] = []
): LinearIssueUpdateRequest {
  const request: LinearIssueUpdateRequest = {};
  if (updates.name !== undefined) {
    request.title = updates.name;
  }
  if (updates.spec !== undefined) {
    request.description = updates.spec;
  }
  if (updates.priority !== undefined) {
    request.priority = workItemPriorityToLinearPriority(updates.priority);
  }
  if (updates.workItemStatus !== undefined) {
    const matchingState = linearWorkflowStateForWorkItemStatus(
      updates.workItemStatus,
      workflowStates
    );
    if (matchingState) {
      request.state_id = matchingState.id;
    }
  }
  return request;
}

export function hasUnsupportedLinearIssueUpdate(
  updates: Partial<WorkItem>
): boolean {
  return Object.keys(updates).some(
    (key) =>
      key !== "name" &&
      key !== "spec" &&
      key !== "priority" &&
      key !== "workItemStatus"
  );
}

export function linearIssueToWorkItem(
  issue: LinearIssueSummary,
  project: LinearProjectSummary
): WorkItem {
  const workItemStatus = issue.state
    ? workItemStatusForLinearWorkflowState(issue.state)
    : "backlog";
  return {
    session_id: issue.id,
    user_id: "linear",
    name: issue.title,
    status: workItemStatus,
    spec: issue.description ?? "",
    star: false,
    target_date: null,
    created_time: issue.created_at ?? "",
    updated_time: issue.updated_at ?? "",
    workItemStatus,
    priority: linearPriorityToWorkItemPriority(issue.priority),
    assignee: issue.assignee
      ? {
          id: issue.assignee.id,
          name: issue.assignee.name,
          email: issue.assignee.email,
        }
      : undefined,
    labels: issue.labels.map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color ?? "#8B8B8B",
    })),
    project: {
      id: project.id,
      name: project.name,
    },
  };
}
