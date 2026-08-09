/**
 * Build Workspace → Project → Session tree. Work items annotate sessions but
 * never become containment parents.
 */
import type {
  ProjectLike,
  ProjectSessionLike,
  ProjectTreeNode,
  WorkItemLike,
} from "./types";

export interface BuildTreeInput {
  workspaceName?: string;
  projects: ProjectLike[];
  /** projectId or slug → work items */
  workItemsByProject: Record<string, WorkItemLike[]>;
  /** Canonical aggregate sessions. Project membership comes from this source. */
  sessions?: ProjectSessionLike[];
  /** Orphan work items (no project) */
  standaloneWorkItems?: WorkItemLike[];
  includeTodos?: boolean;
}

function sessionStatus(raw?: string): string | undefined {
  return raw?.toLowerCase();
}

function sessionNodeFromAggregate(
  session: ProjectSessionLike,
  project: ProjectLike,
  linked?: { workItemId?: string; workItemName?: string }
): ProjectTreeNode {
  return {
    id: `session:${session.session_id}`,
    kind: "session",
    title:
      session.displayLabel ||
      session.name ||
      session.agentRole ||
      session.session_id,
    status: sessionStatus(session.status),
    projectId: project.id,
    projectSlug: project.slug,
    workItemId: session.workItemId ?? linked?.workItemId,
    sessionId: session.session_id,
    children: [],
    meta: {
      parentSessionId: session.parentSessionId ?? null,
      agentRole: session.agentRole,
      ...(linked?.workItemName ? { workItemName: linked.workItemName } : {}),
    },
  };
}

function resolveWorkItems(
  project: ProjectLike,
  workItemsByProject: Record<string, WorkItemLike[]>
): WorkItemLike[] {
  const byId = workItemsByProject[project.id];
  if (byId?.length) return byId;
  if (project.slug) {
    const bySlug = workItemsByProject[project.slug];
    if (bySlug?.length) return bySlug;
  }
  return [];
}

export function buildWorkspaceProjectTree(
  input: BuildTreeInput
): ProjectTreeNode {
  const projectNodes: ProjectTreeNode[] = input.projects.map((project) => {
    const items = resolveWorkItems(project, input.workItemsByProject);
    const linkedBySessionId = new Map<
      string,
      { workItemId: string; workItemName: string }
    >();
    for (const item of items) {
      for (const linked of item.linkedSessions ?? []) {
        if (!linkedBySessionId.has(linked.session_id)) {
          linkedBySessionId.set(linked.session_id, {
            workItemId: item.session_id,
            workItemName: item.name || item.session_id,
          });
        }
      }
    }
    const projectKeys = new Set([project.id, project.slug].filter(Boolean));
    const canonicalSessions = (input.sessions ?? []).filter(
      (session) =>
        projectKeys.has(session.projectId) ||
        projectKeys.has(session.projectSlug)
    );
    const sessionsById = new Map<string, ProjectTreeNode>();
    for (const session of canonicalSessions) {
      if (!sessionsById.has(session.session_id)) {
        sessionsById.set(
          session.session_id,
          sessionNodeFromAggregate(
            session,
            project,
            linkedBySessionId.get(session.session_id)
          )
        );
      }
    }
    const sessions = [...sessionsById.values()];
    return {
      id: `project:${project.id}`,
      kind: "project" as const,
      title: project.name,
      status: project.status,
      projectId: project.id,
      projectSlug: project.slug,
      children: sessions,
      meta: {
        workItemCount: items.length,
        sessionCount: sessions.length,
        slug: project.slug,
      },
    };
  });

  const standalone = input.standaloneWorkItems ?? [];

  return {
    id: "workspace:root",
    kind: "workspace",
    title: input.workspaceName ?? "Workspace",
    children: projectNodes,
    meta: {
      projectCount: input.projects.length,
      standaloneWorkItemMetadataCount: standalone.length,
    },
  };
}

export function flattenTree(root: ProjectTreeNode): ProjectTreeNode[] {
  const out: ProjectTreeNode[] = [];
  const walk = (node: ProjectTreeNode) => {
    out.push(node);
    node.children.forEach(walk);
  };
  walk(root);
  return out;
}

export function countByKind(root: ProjectTreeNode): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of flattenTree(root)) {
    counts[node.kind] = (counts[node.kind] ?? 0) + 1;
  }
  return counts;
}
