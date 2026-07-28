/**
 * Build Workspace → Project → WorkItem → Session/Todo tree.
 */
import type { ProjectLike, ProjectTreeNode, WorkItemLike } from "./types";

export interface BuildTreeInput {
  workspaceName?: string;
  projects: ProjectLike[];
  /** projectId or slug → work items */
  workItemsByProject: Record<string, WorkItemLike[]>;
  /** Orphan work items (no project) */
  standaloneWorkItems?: WorkItemLike[];
  includeTodos?: boolean;
}

function sessionStatus(raw?: string): string | undefined {
  return raw?.toLowerCase();
}

function mapWorkItemNode(
  wi: WorkItemLike,
  projectId?: string,
  projectSlug?: string,
  includeTodos = true
): ProjectTreeNode {
  const children: ProjectTreeNode[] = [];

  if (includeTodos) {
    for (const todo of wi.todos ?? []) {
      children.push({
        id: `todo:${wi.session_id}:${todo.id}`,
        kind: "todo",
        title: todo.content || todo.id,
        status: todo.status,
        projectId,
        projectSlug,
        workItemId: wi.session_id,
        children: [],
        meta: { todoId: todo.id },
      });
    }
  }

  for (const ls of wi.linkedSessions ?? []) {
    children.push({
      id: `session:${ls.session_id}`,
      kind: "session",
      title:
        ls.sub_agent_name ||
        ls.agent_role ||
        ls.session_id.slice(0, 8) ||
        "session",
      status: sessionStatus(ls.status),
      projectId,
      projectSlug,
      workItemId: wi.session_id,
      sessionId: ls.session_id,
      children: [],
      meta: {
        parentSessionId: ls.parent_session_id ?? null,
        sessionType: ls.session_type,
        agentRole: ls.agent_role,
      },
    });
  }

  return {
    id: `work_item:${wi.session_id}`,
    kind: "work_item",
    title: wi.name || wi.session_id,
    status: wi.workItemStatus ?? wi.status,
    projectId,
    projectSlug,
    workItemId: wi.session_id,
    children,
    meta: {
      linkedSessionCount: wi.linkedSessions?.length ?? 0,
      todoCount: wi.todos?.length ?? 0,
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
  const includeTodos = input.includeTodos !== false;
  const projectNodes: ProjectTreeNode[] = input.projects.map((project) => {
    const items = resolveWorkItems(project, input.workItemsByProject);
    return {
      id: `project:${project.id}`,
      kind: "project" as const,
      title: project.name,
      status: project.status,
      projectId: project.id,
      projectSlug: project.slug,
      children: items.map((wi) =>
        mapWorkItemNode(wi, project.id, project.slug, includeTodos)
      ),
      meta: {
        workItemCount: items.length,
        slug: project.slug,
      },
    };
  });

  const standalone = input.standaloneWorkItems ?? [];
  if (standalone.length > 0) {
    projectNodes.push({
      id: "bucket:unassigned",
      kind: "unassigned",
      title: "Unassigned",
      children: standalone.map((wi) =>
        mapWorkItemNode(wi, undefined, undefined, includeTodos)
      ),
      meta: { workItemCount: standalone.length },
    });
  }

  return {
    id: "workspace:root",
    kind: "workspace",
    title: input.workspaceName ?? "Workspace",
    children: projectNodes,
    meta: {
      projectCount: input.projects.length,
      standaloneCount: standalone.length,
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
