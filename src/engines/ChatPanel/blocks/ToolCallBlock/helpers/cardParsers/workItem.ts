/**
 * Work item + project card parsers, plus the status/priority normalisation
 * tables they share.
 */
import type { WorkItemData } from "@src/api/http/project";

import type {
  ProjectCardData,
  WorkItemCardData,
  WorkItemPriority,
  WorkItemStatus,
} from "../../types";
import { asRecord, getString } from "./primitives";

const WORK_ITEM_STATUS_MAP: Record<string, WorkItemStatus> = {
  todo: "todo",
  "to do": "todo",
  "to-do": "todo",
  backlog: "backlog",
  "in progress": "in_progress",
  in_progress: "in_progress",
  "in review": "in_review",
  in_review: "in_review",
  done: "done",
  completed: "done",
  cancelled: "cancelled",
  canceled: "cancelled",
};

const WORK_ITEM_PRIORITY_MAP: Record<string, WorkItemPriority> = {
  urgent: "urgent",
  high: "high",
  medium: "medium",
  low: "low",
  none: "none",
  no_priority: "none",
};

function normalizeWorkItemStatus(raw: string): WorkItemStatus | string {
  return WORK_ITEM_STATUS_MAP[raw.toLowerCase()] ?? raw;
}

function normalizeWorkItemPriority(
  raw: string
): WorkItemPriority | string | undefined {
  return WORK_ITEM_PRIORITY_MAP[raw.toLowerCase()] ?? raw;
}

export function parseWorkItemCardResult(
  args: Record<string, unknown>,
  result: Record<string, unknown>
): WorkItemCardData | null {
  const action = typeof args.action === "string" ? args.action : "";
  const singleActions = [
    "create",
    "create_item",
    "update",
    "update_item",
    "get",
    "get_item",
  ];
  if (!singleActions.includes(action)) return null;

  const title =
    (typeof result.title === "string" ? result.title : null) ??
    (typeof args.title === "string" ? args.title : null);
  if (!title) return null;

  const rawId =
    (typeof result.id === "string" ? result.id : null) ??
    (typeof result.short_id === "string" ? result.short_id : null) ??
    "";
  const rawStatus =
    (typeof result.status === "string" ? result.status : null) ??
    (typeof args.status === "string" ? args.status : null) ??
    "todo";
  const rawPriority =
    (typeof result.priority === "string" ? result.priority : null) ??
    (typeof args.priority === "string" ? args.priority : null);
  const projectName =
    (typeof result.project_name === "string" ? result.project_name : null) ??
    (typeof result.project === "string" ? result.project : null) ??
    undefined;
  const assignee =
    (typeof result.assignee === "string" ? result.assignee : null) ?? undefined;
  const dueDate =
    (typeof result.due_date === "string" ? result.due_date : null) ?? undefined;
  const shortId =
    (typeof result.short_id === "string" ? result.short_id : null) ?? undefined;

  return {
    id: rawId,
    title,
    status: normalizeWorkItemStatus(rawStatus),
    priority: rawPriority ? normalizeWorkItemPriority(rawPriority) : undefined,
    projectName,
    assignee,
    dueDate,
    shortId,
  };
}

export function parseProjectCardResult(
  args: Record<string, unknown>,
  result: Record<string, unknown>
): ProjectCardData | null {
  const action = typeof args.action === "string" ? args.action : "";
  const singleActions = ["create", "create_item", "update", "update_item"];
  if (!singleActions.includes(action)) return null;

  const name =
    (typeof result.name === "string" ? result.name : null) ??
    (typeof result.title === "string" ? result.title : null) ??
    (typeof args.name === "string" ? args.name : null) ??
    (typeof args.title === "string" ? args.title : null);
  if (!name) return null;

  const rawId =
    (typeof result.id === "string" ? result.id : null) ??
    (typeof result.slug === "string" ? result.slug : null) ??
    "";
  const rawStatus =
    (typeof result.status === "string" ? result.status : null) ??
    (typeof args.status === "string" ? args.status : null) ??
    "backlog";
  const slug =
    (typeof result.slug === "string" ? result.slug : null) ?? undefined;
  const targetDate =
    (typeof result.target_date === "string" ? result.target_date : null) ??
    undefined;
  const workItemCount =
    typeof result.work_item_count === "number"
      ? result.work_item_count
      : undefined;
  const health =
    (typeof result.health === "string" ? result.health : null) ?? undefined;

  return {
    id: rawId,
    name,
    slug,
    status: normalizeWorkItemStatus(rawStatus),
    targetDate,
    workItemCount,
    health,
  };
}

export function parseWorkItem(data: unknown): WorkItemData | undefined {
  const item = asRecord(data);
  const frontmatter = asRecord(item?.frontmatter);
  if (
    !item ||
    !frontmatter ||
    typeof item.body !== "string" ||
    !getString(item.filename) ||
    !getString(frontmatter.id) ||
    !getString(frontmatter.short_id) ||
    !getString(frontmatter.title) ||
    !getString(frontmatter.status) ||
    !getString(frontmatter.priority) ||
    !getString(frontmatter.created_at) ||
    !getString(frontmatter.updated_at)
  ) {
    return undefined;
  }
  return item as unknown as WorkItemData;
}
