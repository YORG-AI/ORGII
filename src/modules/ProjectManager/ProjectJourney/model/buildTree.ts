/**
 * Build Workspace → Project → Session tree. Work items annotate sessions but
 * never become containment parents.
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

function mapSessionNode(
  wi: WorkItemLike,
  projectId?: string,
  projectSlug?: string
): ProjectTreeNode[] {
  return (wi.linkedSessions ?? []).map((ls) => ({
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
      // This is metadata only. The parent in the tree is always Project.
      workItemName: wi.name || wi.session_id,
    },
  }));
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
    const sessions = items.flatMap((wi) =>
      mapSessionNode(wi, project.id, project.slug)
    );
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
  if (standalone.length > 0) {
    projectNodes.push({
      id: "bucket:unassigned",
      kind: "unassigned",
      title: "Unassigned",
      children: standalone.flatMap((wi) => mapSessionNode(wi)),
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
