/**
 * Project store data adapters.
 *
 * Converts between wire-format types from the `project_*` Tauri
 * commands and the UI-facing `Project` / `WorkItem` types the
 * components consume. Same shape as the legacy `orgiiProject/adapters`,
 * minus the file-based assumptions — the wire types now come from
 * SQLite, not YAML.
 */
import type {
  ProjectHealth,
  ProjectPriority,
  ProjectStatus,
  Project as UIProject,
} from "@src/types/core/project";
import {
  GITHUB_ISSUE_STATUS,
  type WorkItem as UIWorkItem,
  type WorkItemPriority,
  type WorkItemStatus,
} from "@src/types/core/workItem";

import type {
  EnrichedWorkItem,
  LabelEntry,
  MemberEntry,
  ProjectData,
  WorkItemData,
  WorkItemFrontmatter,
} from "./types";

// ============================================
// Validation
// ============================================

const FALLBACK_MEMBER_COLOR = "#6b7280";

const VALID_STORY_STATUSES: ReadonlySet<string> = new Set<ProjectStatus>([
  "backlog",
  "planned",
  "in_progress",
  "completed",
  "canceled",
]);

const VALID_STORY_PRIORITIES: ReadonlySet<string> = new Set<ProjectPriority>([
  "urgent",
  "high",
  "medium",
  "low",
  "none",
]);

const VALID_STORY_HEALTH: ReadonlySet<string> = new Set<ProjectHealth>([
  "on_track",
  "at_risk",
  "off_track",
  "no_updates",
]);

const VALID_WORK_ITEM_PRIORITIES: ReadonlySet<string> =
  new Set<WorkItemPriority>(["urgent", "high", "medium", "low", "none"]);

function validateEnum<T extends string>(
  value: string | undefined,
  validSet: ReadonlySet<string>,
  fallback: T
): T {
  if (value && validSet.has(value)) return value as T;
  return fallback;
}

function mapWorkItemStatus(status: string | undefined): WorkItemStatus {
  if (
    status === GITHUB_ISSUE_STATUS.OPEN ||
    status === GITHUB_ISSUE_STATUS.CLOSED
  ) {
    return status;
  }
  return FILE_TO_UI_STATUS[status ?? ""] ?? "backlog";
}

// ============================================
// Lookup helpers
// ============================================

function resolveLabelIds(
  ids: string[],
  labelMap: Map<string, LabelEntry>
): { id: string; name: string; color: string }[] {
  return ids.map((labelId) => {
    const label = labelMap.get(labelId);
    return {
      id: label?.id ?? labelId,
      name: label?.name ?? labelId,
      color: label?.color ?? FALLBACK_MEMBER_COLOR,
    };
  });
}

function resolveMemberId(
  memberId: string | undefined,
  memberMap: Map<string, MemberEntry>
): { id: string; name: string; avatar?: string; color: string } | undefined {
  if (!memberId) return undefined;
  const member = memberMap.get(memberId);
  const name = member?.name ?? memberId;
  return {
    id: memberId,
    name,
    avatar: member?.avatar,
    color: FALLBACK_MEMBER_COLOR,
  };
}

function resolveMemberIds(
  ids: string[],
  memberMap: Map<string, MemberEntry>
): { id: string; name: string; avatar?: string; color: string }[] {
  return ids.map((memberId) => {
    const member = memberMap.get(memberId);
    const name = member?.name ?? memberId;
    return {
      id: memberId,
      name,
      avatar: member?.avatar,
      color: FALLBACK_MEMBER_COLOR,
    };
  });
}

// ============================================
// Status mapping
// ============================================

const FILE_TO_UI_STATUS: Record<string, WorkItemStatus> = {
  backlog: "backlog",
  planned: "planned",
  todo: "planned",
  in_progress: "in_progress",
  in_review: "in_review",
  completed: "completed",
  cancelled: "cancelled",
  duplicate: "duplicate",
};

const UI_TO_FILE_STATUS: Record<WorkItemStatus, string> = {
  backlog: "backlog",
  planned: "planned",
  in_progress: "in_progress",
  in_review: "in_review",
  completed: "completed",
  cancelled: "cancelled",
  duplicate: "duplicate",
  open: "open",
  closed: "closed",
};

// ============================================
// Project adapters
// ============================================

export function projectDataToUI(
  projectData: ProjectData,
  context: {
    labelMap: Map<string, LabelEntry>;
    memberMap: Map<string, MemberEntry>;
    workItemCounts?: Map<string, number>;
  }
): UIProject {
  const { meta } = projectData;
  const lead = resolveMemberId(meta.lead, context.memberMap);
  const members = resolveMemberIds(meta.members, context.memberMap);
  const labels = resolveLabelIds(meta.labels, context.labelMap);
  const workItemCount = context.workItemCounts?.get(meta.id) ?? 0;

  return {
    id: meta.id,
    name: meta.name,
    description: projectData.description || meta.name,
    slug: projectData.slug,
    orgId: meta.org_id,
    workItemPrefix: meta.work_item_prefix,
    workItemPrefixCustom: meta.work_item_prefix_custom,
    status: validateEnum<ProjectStatus>(
      meta.status,
      VALID_STORY_STATUSES,
      "backlog"
    ),
    priority: validateEnum<ProjectPriority>(
      meta.priority,
      VALID_STORY_PRIORITIES,
      "none"
    ),
    health: validateEnum<ProjectHealth>(
      meta.health,
      VALID_STORY_HEALTH,
      "no_updates"
    ),
    lead,
    members,
    teams: [],
    labels,
    linkedRepos: meta.linked_repos.map((repoPath) => ({
      id: repoPath,
      name: repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath,
      path: repoPath,
    })),
    startDate: meta.start_date,
    targetDate: meta.target_date,
    createdAt: meta.created_at,
    updatedAt: meta.updated_at,
    workItemCount,
    completionPercentage: 0,
    statusBreakdown: {
      backlog: 0,
      planned: 0,
      in_progress: 0,
      in_review: 0,
      completed: 0,
      cancelled: 0,
    },
  };
}

// ============================================
// Work item adapters
// ============================================

export function workItemDataToUI(
  itemData: WorkItemData,
  context: {
    labelMap: Map<string, LabelEntry>;
    memberMap: Map<string, MemberEntry>;
    projectNameMap?: Map<string, string>;
  }
): UIWorkItem {
  const { frontmatter } = itemData;
  const assignee = resolveMemberId(frontmatter.assignee, context.memberMap);
  const createdBy = resolveMemberId(frontmatter.created_by, context.memberMap);
  const labels = resolveLabelIds(frontmatter.labels, context.labelMap);
  const projectName =
    frontmatter.project && context.projectNameMap
      ? (context.projectNameMap.get(frontmatter.project) ?? "")
      : "";

  const resolvedTodos =
    frontmatter.todos?.map((todo) => ({
      id: todo.id,
      content: todo.content,
      status: todo.status,
    })) ?? [];
  const comments = frontmatter.comments ?? [];

  return {
    session_id: frontmatter.id,
    shortId: frontmatter.short_id,
    user_id: frontmatter.created_by ?? "",
    name: frontmatter.title,
    target_date: frontmatter.target_date ?? null,
    updated_time: frontmatter.updated_at,
    created_time: frontmatter.created_at,
    star: frontmatter.starred,
    spec: itemData.body,
    status: frontmatter.status,
    workItemStatus: mapWorkItemStatus(frontmatter.status),
    priority: validateEnum<WorkItemPriority>(
      frontmatter.priority,
      VALID_WORK_ITEM_PRIORITIES,
      "none"
    ),
    assignee,
    assigneeType: frontmatter.assignee_type,
    createdBy,
    labels,
    project: frontmatter.project
      ? { id: frontmatter.project, name: projectName }
      : undefined,
    milestone: frontmatter.milestone
      ? { id: frontmatter.milestone, name: "" }
      : undefined,
    startDate: frontmatter.start_date,
    endDate: frontmatter.target_date,
    subIssueCount: 0,
    todos: resolvedTodos,
    comments,
    orchestratorConfig: frontmatter.orchestrator_config,
    orchestratorState: frontmatter.orchestrator_state,
    proofOfWork: frontmatter.proof_of_work,
    followUpItems: frontmatter.follow_up_items,
    linkedSessions: frontmatter.linked_sessions,
    schedule: frontmatter.schedule,
    routineSource: frontmatter.routine_source,
    executionLock: frontmatter.execution_lock,
    closeOut: frontmatter.close_out,
    workProducts: frontmatter.work_products,
  };
}

/**
 * Lift a raw standalone work item (`work_item_read_standalone_items`)
 * into the `EnrichedWorkItem` shape used by list surfaces. Standalone
 * rows have no project, and without a project there is no member/label
 * file to resolve against, so people fall back to their raw ids (same
 * convention as `workItemDataToUI` with empty maps).
 */
export function standaloneWorkItemDataToEnriched(
  itemData: WorkItemData
): EnrichedWorkItem {
  const { frontmatter } = itemData;
  const emptyMemberMap = new Map<string, MemberEntry>();
  return {
    id: frontmatter.id,
    shortId: frontmatter.short_id,
    title: frontmatter.title,
    body: itemData.body,
    filename: itemData.filename,
    status: frontmatter.status,
    priority: frontmatter.priority,
    starred: frontmatter.starred,
    assignee: resolveMemberId(frontmatter.assignee, emptyMemberMap),
    assigneeType: frontmatter.assignee_type,
    labels: resolveLabelIds(frontmatter.labels ?? [], new Map()),
    project: undefined,
    milestone: frontmatter.milestone
      ? { id: frontmatter.milestone, name: frontmatter.milestone }
      : undefined,
    startDate: frontmatter.start_date,
    targetDate: frontmatter.target_date,
    createdAt: frontmatter.created_at,
    updatedAt: frontmatter.updated_at,
    deletedAt: frontmatter.deleted_at,
    createdBy: frontmatter.created_by,
    createdByPerson: resolveMemberId(frontmatter.created_by, emptyMemberMap),
    todos: frontmatter.todos ?? [],
    comments: frontmatter.comments ?? [],
    history: frontmatter.history ?? [],
    linkedSessions: frontmatter.linked_sessions ?? [],
    proofOfWork: frontmatter.proof_of_work,
    orchestratorConfig: frontmatter.orchestrator_config,
    orchestratorState: frontmatter.orchestrator_state,
    followUpItems: frontmatter.follow_up_items ?? [],
    schedule: frontmatter.schedule,
    routineSource: frontmatter.routine_source,
    executionLock: frontmatter.execution_lock,
    closeOut: frontmatter.close_out,
    workProducts: frontmatter.work_products ?? [],
  };
}

export function uiWorkItemToFrontmatter(
  workItem: UIWorkItem,
  existingFrontmatter?: WorkItemFrontmatter
): WorkItemFrontmatter {
  const now = new Date().toISOString();

  const targetDate = workItem.endDate ?? workItem.target_date ?? undefined;
  const createdBy =
    existingFrontmatter?.created_by ?? workItem.user_id ?? undefined;
  const createdAt =
    existingFrontmatter?.created_at ?? workItem.created_time ?? now;
  const starred = workItem.star ?? false;
  const labelIds = workItem.labels?.map((label) => label.id) ?? [];
  const resolvedTodos =
    workItem.todos?.map((todo) => ({
      id: todo.id,
      content: todo.content,
      status: todo.status,
    })) ??
    existingFrontmatter?.todos ??
    [];
  const resolvedComments =
    workItem.comments?.map((comment) => ({
      id: comment.id,
      author: comment.author,
      content: comment.content,
      created_at: comment.created_at,
    })) ??
    existingFrontmatter?.comments ??
    [];

  return {
    id: existingFrontmatter?.id ?? workItem.session_id,
    short_id: existingFrontmatter?.short_id ?? "",
    title: workItem.name,
    project: workItem.project?.id,
    status: workItem.workItemStatus
      ? UI_TO_FILE_STATUS[workItem.workItemStatus]
      : (existingFrontmatter?.status ?? "backlog"),
    priority: workItem.priority ?? "none",
    assignee: workItem.assignee?.id,
    assignee_type: workItem.assigneeType,
    labels: labelIds,
    milestone: workItem.milestone?.id,
    parent: existingFrontmatter?.parent,
    start_date: workItem.startDate,
    target_date: targetDate,
    created_by: createdBy,
    created_at: createdAt,
    updated_at: now,
    starred,
    todos: resolvedTodos,
    comments: resolvedComments,
    orchestrator_config:
      workItem.orchestratorConfig ?? existingFrontmatter?.orchestrator_config,
    // Backend-managed fields preserved verbatim — the orchestrator
    // and worker subsystems write these out-of-band, so a UI write
    // must never clobber them.
    orchestrator_state: existingFrontmatter?.orchestrator_state,
    proof_of_work: existingFrontmatter?.proof_of_work,
    linked_sessions: existingFrontmatter?.linked_sessions,
    follow_up_items: existingFrontmatter?.follow_up_items,
    schedule:
      workItem.schedule !== undefined
        ? (workItem.schedule ?? undefined)
        : (existingFrontmatter?.schedule ?? undefined),
    routine_source: existingFrontmatter?.routine_source,
    execution_lock: existingFrontmatter?.execution_lock,
    close_out: existingFrontmatter?.close_out,
    work_products: existingFrontmatter?.work_products ?? [],
  };
}

// ============================================
// Lookup map builders
// ============================================

export function buildLabelMap(labels: LabelEntry[]): Map<string, LabelEntry> {
  return new Map(labels.map((label) => [label.id, label]));
}

export function buildMemberMap(
  members: MemberEntry[]
): Map<string, MemberEntry> {
  return new Map(members.map((member) => [member.id, member]));
}

// ============================================
// Enriched work item adapter
// ============================================

/**
 * Convert `EnrichedWorkItem` (with Rust-resolved labels/members) to
 * the UI `WorkItem` shape. Simpler than `workItemDataToUI` because
 * the heavy lifting already happened server-side.
 */
export function enrichedWorkItemToUI(item: EnrichedWorkItem): UIWorkItem {
  return {
    session_id: item.id,
    shortId: item.shortId,
    user_id: item.createdBy ?? "",
    name: item.title,
    target_date: item.targetDate ?? null,
    updated_time: item.updatedAt,
    created_time: item.createdAt,
    deletedAt: item.deletedAt,
    star: item.starred,
    spec: item.body,
    status: item.status,
    workItemStatus: mapWorkItemStatus(item.status),
    priority: validateEnum<WorkItemPriority>(
      item.priority,
      VALID_WORK_ITEM_PRIORITIES,
      "none"
    ),
    assignee: item.assignee,
    assigneeType: item.assigneeType,
    createdBy: item.createdByPerson,
    labels: item.labels,
    project: item.project,
    milestone: item.milestone,
    startDate: item.startDate,
    endDate: item.targetDate,
    subIssueCount: 0,
    todos: item.todos,
    comments: item.comments,
    history: item.history,
    orchestratorConfig: item.orchestratorConfig,
    orchestratorState: item.orchestratorState,
    proofOfWork: item.proofOfWork,
    followUpItems: item.followUpItems,
    linkedSessions: item.linkedSessions,
    schedule: item.schedule,
    routineSource: item.routineSource,
    executionLock: item.executionLock,
    closeOut: item.closeOut,
    workProducts: item.workProducts,
  };
}
