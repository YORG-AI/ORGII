import {
  type LinkedSession,
  type ProjectData,
  type TodoEntry,
  type WorkItemData,
  type WorkItemHandoff,
  projectApi,
} from "@src/api/http/project";
import { linkSessionToWorkItem } from "@src/api/tauri/agent/session";
import { createWorkItemFromDraft } from "@src/modules/ProjectManager/WorkItems/components/CreateWorkItemView/createWorkItemFromDraft";
import type { Session } from "@src/store/session";

import type { TeamInboxCreatedWorkItem } from "./domain";
import type {
  TeamInboxHandoffProject,
  TeamInboxSessionHandoffDraft,
} from "./domain";

const MAX_TITLE_LENGTH = 120;
const MAX_REQUEST_LENGTH = 4_000;
const MAX_HANDOFF_NOTE_LENGTH = 1_000;

export interface CreateFromSessionDependencies {
  create: (options: Parameters<typeof createWorkItemFromDraft>[0]) => Promise<{
    shortId: string;
  }>;
  link: (
    input: Parameters<typeof linkSessionToWorkItem>[0]
  ) => Promise<unknown>;
  readProjects: () => Promise<ProjectData[]>;
  readProjectWorkItems: (projectSlug: string) => Promise<WorkItemData[]>;
  readStandaloneWorkItems: (options?: {
    orgId?: string;
  }) => Promise<WorkItemData[]>;
  updateProjectWorkItem: (
    projectSlug: string,
    shortId: string,
    updates: Parameters<typeof projectApi.updateWorkItemPartial>[2]
  ) => Promise<unknown>;
}

export interface CreateWorkItemFromSessionOptions {
  activeOrgId?: string | null;
  assigneeMemberId?: string;
  assigneeMemberName?: string;
  handoffNote?: string;
  recipientIsCurrentUser?: boolean;
  selectedProjectSlug?: string;
  session: Session;
  signal?: AbortSignal;
  senderMemberId?: string;
  senderMemberName?: string;
  title?: string;
}

const DEFAULT_DEPENDENCIES: CreateFromSessionDependencies = {
  create: createWorkItemFromDraft,
  link: linkSessionToWorkItem,
  readProjects: projectApi.readProjects,
  readProjectWorkItems: projectApi.readWorkItems,
  readStandaloneWorkItems: projectApi.readStandaloneWorkItems,
  updateProjectWorkItem: projectApi.updateWorkItemPartial,
};

function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Session to Work Item creation was cancelled");
  error.name = "AbortError";
  throw error;
}

function firstMeaningfulLine(value?: string): string | undefined {
  return value
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function clamp(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function sessionStatus(session: Session): LinkedSession["status"] {
  if (session.status === "completed") return "completed";
  if (session.status === "cancelled" || session.status === "killed") {
    return "cancelled";
  }
  if (
    session.status === "failed" ||
    session.status === "error" ||
    session.status === "timeout" ||
    session.status === "abandoned"
  ) {
    return "failed";
  }
  return "running";
}

export function sessionWorkItemTitle(
  session: Session,
  draggedTitle?: string
): string {
  const title =
    draggedTitle?.trim() ||
    session.displayLabel?.trim() ||
    session.name?.trim() ||
    firstMeaningfulLine(session.user_input) ||
    "Session follow-up";
  return clamp(title, MAX_TITLE_LENGTH);
}

export function sessionWorkItemDescription(
  session: Session,
  title: string
): string {
  const request = session.user_input?.trim();
  const impact = [
    session.filesChanged
      ? `${session.filesChanged} file${session.filesChanged === 1 ? "" : "s"} changed`
      : null,
    session.linesAdded ? `+${session.linesAdded}` : null,
    session.linesRemoved ? `−${session.linesRemoved}` : null,
  ].filter(Boolean);
  const touchedFiles = session.touchedFiles?.slice(0, 8) ?? [];

  return [
    "## Source session",
    `[${escapeMarkdownLabel(title)}](session://${session.session_id})`,
    "",
    request ? "## Original request" : null,
    request ? clamp(request, MAX_REQUEST_LENGTH) : null,
    impact.length > 0 || touchedFiles.length > 0 ? "" : null,
    impact.length > 0 || touchedFiles.length > 0 ? "## Impact snapshot" : null,
    impact.length > 0 ? impact.join(" · ") : null,
    ...touchedFiles.map((path) => `- \`${path.replace(/`/g, "\\`")}\``),
  ]
    .filter((part): part is string => part != null)
    .join("\n");
}

export function linkedSessionSnapshot(session: Session): LinkedSession {
  return {
    session_id: session.session_id,
    session_type: session.category === "cli_agent" ? "cli" : "native",
    agent_role: "custom",
    started_at: session.created_at,
    completed_at: session.completed_at,
    status: sessionStatus(session),
    cost_usd: 0,
    total_tokens: session.totalTokens ?? 0,
    parent_session_id: session.parentSessionId,
    result_preview: sessionWorkItemTitle(session),
  };
}

export function sessionWorkItemTodos(session: Session): TodoEntry[] {
  return (session.user_input ?? "")
    .split(/\r?\n/)
    .flatMap((line, index) => {
      const match = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
      if (!match) return [];
      return [
        {
          id: `session-${index + 1}`,
          content: clamp(match[2], MAX_TITLE_LENGTH),
          status: match[1].toLowerCase() === "x" ? "completed" : "pending",
        },
      ];
    })
    .slice(0, 20);
}

export function sessionHandoffDraft(
  session: Session,
  projects: readonly TeamInboxHandoffProject[],
  draggedTitle?: string,
  sourceProjectSlug?: string
): TeamInboxSessionHandoffDraft {
  const impact = [
    session.filesChanged
      ? `${session.filesChanged} file${session.filesChanged === 1 ? "" : "s"} changed`
      : null,
    session.linesAdded ? `+${session.linesAdded}` : null,
    session.linesRemoved ? `−${session.linesRemoved}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    sessionId: session.session_id,
    title: sessionWorkItemTitle(session, draggedTitle),
    sourceProjectSlug,
    projects: [...projects],
    requestPreview: session.user_input?.trim()
      ? clamp(session.user_input.trim(), 360)
      : undefined,
    impactSummary: impact || undefined,
    todoCount: sessionWorkItemTodos(session).length,
  };
}

export function sessionWorkItemHandoff(
  options: CreateWorkItemFromSessionOptions,
  requestedAt = new Date().toISOString()
): WorkItemHandoff | undefined {
  const senderMemberId = options.senderMemberId?.trim();
  const recipientMemberId = options.assigneeMemberId?.trim();
  if (
    !senderMemberId ||
    !recipientMemberId ||
    options.recipientIsCurrentUser ||
    senderMemberId === recipientMemberId
  ) {
    return undefined;
  }
  const note = options.handoffNote?.trim();
  return {
    id: `session-handoff:${options.session.session_id}:${recipientMemberId}:${requestedAt}`,
    status: "pending",
    senderMemberId,
    senderName: options.senderMemberName?.trim() || senderMemberId,
    recipientMemberId,
    recipientName: options.assigneeMemberName?.trim() || recipientMemberId,
    note: note ? clamp(note, MAX_HANDOFF_NOTE_LENGTH) : undefined,
    requestedAt,
  };
}

function findReusableWorkItem(
  items: readonly WorkItemData[],
  session: Session
): WorkItemData | undefined {
  return items.find(
    (item) =>
      item.frontmatter.short_id === session.workItemId ||
      item.frontmatter.linked_sessions?.some(
        (linked) => linked.session_id === session.session_id
      )
  );
}

async function reconcileReusableWorkItem(
  existing: WorkItemData,
  projectSlug: string | undefined,
  options: CreateWorkItemFromSessionOptions,
  dependencies: CreateFromSessionDependencies
): Promise<void> {
  if (!projectSlug) return;

  const { frontmatter } = existing;
  const requestedHandoff = sessionWorkItemHandoff(options);
  const currentHandoff = frontmatter.handoff;
  const currentSessionHandoff =
    currentHandoff?.id.startsWith(
      `session-handoff:${options.session.session_id}:`
    ) ?? false;
  const matchingPendingHandoff =
    currentHandoff?.status === "pending" &&
    requestedHandoff !== undefined &&
    currentHandoff.senderMemberId === requestedHandoff.senderMemberId &&
    currentHandoff.recipientMemberId === requestedHandoff.recipientMemberId;
  const nextHandoff =
    requestedHandoff && matchingPendingHandoff
      ? currentHandoff
      : requestedHandoff;
  const linkedSessions = frontmatter.linked_sessions ?? [];
  const hasSessionLink = linkedSessions.some(
    (linked) => linked.session_id === options.session.session_id
  );
  const shouldWriteHandoff =
    requestedHandoff !== undefined
      ? !matchingPendingHandoff
      : currentSessionHandoff;
  const shouldWriteAssignee =
    Boolean(options.assigneeMemberId) &&
    frontmatter.assignee !== options.assigneeMemberId;

  if (!shouldWriteHandoff && !shouldWriteAssignee && hasSessionLink) return;

  await dependencies.updateProjectWorkItem(projectSlug, frontmatter.short_id, {
    ...(shouldWriteAssignee
      ? {
          assignee: options.assigneeMemberId,
          assigneeType: "member",
        }
      : {}),
    ...(shouldWriteHandoff ? { handoff: nextHandoff ?? null } : {}),
    ...(!hasSessionLink
      ? {
          linkedSessions: [
            ...linkedSessions,
            linkedSessionSnapshot(options.session),
          ],
        }
      : {}),
    ...(options.senderMemberId
      ? {
          actor: {
            id: options.senderMemberId,
            name: options.senderMemberName?.trim() || options.senderMemberId,
          },
        }
      : {}),
  });
}

async function reuseWorkItem(
  existing: WorkItemData,
  projectSlug: string | undefined,
  options: CreateWorkItemFromSessionOptions,
  dependencies: CreateFromSessionDependencies
): Promise<TeamInboxCreatedWorkItem> {
  await reconcileReusableWorkItem(existing, projectSlug, options, dependencies);
  await ensureReverseLink(
    options.session,
    projectSlug,
    existing.frontmatter.short_id,
    dependencies,
    options.signal
  );
  return {
    projectId: projectSlug ?? "",
    workItemId: existing.frontmatter.short_id,
    reused: true,
  };
}

async function resolveProject(
  session: Session,
  selectedProjectSlug: string | undefined,
  dependencies: CreateFromSessionDependencies,
  signal?: AbortSignal
): Promise<ProjectData | undefined> {
  if (!selectedProjectSlug && !session.projectSlug && !session.projectId) {
    return undefined;
  }
  const projects = await dependencies.readProjects();
  abortIfNeeded(signal);
  const project = selectedProjectSlug
    ? projects.find((candidate) => candidate.slug === selectedProjectSlug)
    : projects.find(
        (candidate) =>
          candidate.slug === session.projectSlug ||
          candidate.meta.id === session.projectId
      );
  if (!project) {
    throw new Error(
      selectedProjectSlug
        ? "The selected project is no longer available"
        : "The Session project is no longer available"
    );
  }
  return project;
}

async function ensureReverseLink(
  session: Session,
  projectSlug: string | undefined,
  workItemId: string,
  dependencies: CreateFromSessionDependencies,
  signal?: AbortSignal
): Promise<void> {
  if (!projectSlug || session.workItemId === workItemId) return;
  abortIfNeeded(signal);
  await dependencies.link({
    sessionId: session.session_id,
    projectSlug,
    workItemId,
    agentRole: "custom",
  });
  abortIfNeeded(signal);
}

/**
 * Demand-driven Session → Work Item transaction.
 *
 * The Work Item is written once with its Session provenance. If the reverse
 * Session link fails, retry first finds that Work Item and repairs the link
 * instead of creating a duplicate.
 */
export async function createWorkItemFromSession(
  options: CreateWorkItemFromSessionOptions,
  dependencies: CreateFromSessionDependencies = DEFAULT_DEPENDENCIES
): Promise<TeamInboxCreatedWorkItem> {
  const { session, signal } = options;
  abortIfNeeded(signal);

  const project = await resolveProject(
    session,
    options.selectedProjectSlug,
    dependencies,
    signal
  );
  const projectSlug = project?.slug;
  const projectId = projectSlug ?? "";

  const existingItems = projectSlug
    ? await dependencies.readProjectWorkItems(projectSlug)
    : await dependencies.readStandaloneWorkItems(
        options.activeOrgId ? { orgId: options.activeOrgId } : undefined
      );
  abortIfNeeded(signal);
  const existing = findReusableWorkItem(existingItems, session);
  if (existing) {
    return reuseWorkItem(existing, projectSlug, options, dependencies);
  }

  const title = sessionWorkItemTitle(session, options.title);
  const created = await dependencies.create({
    draft: {
      name: title,
      description: "",
      status: "planned",
      priority: "none",
      assigneeId: options.assigneeMemberId,
      projectId: project?.meta.id,
      orgId: session.orgId ?? options.activeOrgId ?? undefined,
      labelIds: [],
    },
    description: sessionWorkItemDescription(session, title),
    linkedSessions: [linkedSessionSnapshot(session)],
    todos: sessionWorkItemTodos(session),
    handoff: sessionWorkItemHandoff(options),
    createdByMemberId: options.senderMemberId,
    orgId: session.orgId ?? options.activeOrgId,
    selectedProjectSlug: projectSlug,
  });
  abortIfNeeded(signal);
  await ensureReverseLink(
    session,
    projectSlug,
    created.shortId,
    dependencies,
    signal
  );

  return {
    projectId,
    workItemId: created.shortId,
    reused: false,
  };
}
