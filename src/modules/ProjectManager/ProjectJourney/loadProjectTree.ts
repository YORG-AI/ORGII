/**
 * Load real projects, canonical sessions, and optional work-item metadata.
 */
import {
  type ProjectData,
  enrichedWorkItemToUI,
  projectApi,
} from "@src/api/http/project";
import {
  sessionAggregateList,
  toFrontendSession,
} from "@src/api/tauri/session";

import {
  DEMO_PROJECT,
  DEMO_WORK_ITEMS,
  type ProjectLike,
  type ProjectSessionLike,
  type ProjectTreeNode,
  type WorkItemLike,
  buildWorkspaceProjectTree,
} from "./model";

export interface ProjectTreeBundle {
  tree: ProjectTreeNode;
  projects: ProjectLike[];
  workItemsByProject: Record<string, WorkItemLike[]>;
  sessions: ProjectSessionLike[];
  standaloneWorkItems: WorkItemLike[];
  usedDemo: boolean;
  error?: string;
}

function projectDataToLike(p: ProjectData): ProjectLike {
  return {
    id: p.meta.id,
    name: p.meta.name,
    slug: p.slug,
    status: p.meta.status,
    description: p.description,
  };
}

export async function loadProjectTreeBundle(options?: {
  forceDemo?: boolean;
  workspaceName?: string;
}): Promise<ProjectTreeBundle> {
  if (options?.forceDemo) {
    const workItemsByProject = {
      [DEMO_PROJECT.id]: DEMO_WORK_ITEMS,
      [DEMO_PROJECT.slug!]: DEMO_WORK_ITEMS,
    };
    return {
      tree: buildWorkspaceProjectTree({
        workspaceName: options.workspaceName ?? "Workspace",
        projects: [DEMO_PROJECT],
        workItemsByProject,
      }),
      projects: [DEMO_PROJECT],
      workItemsByProject,
      sessions: [],
      standaloneWorkItems: [],
      usedDemo: true,
    };
  }

  try {
    const [projectsRaw, sessionResponse] = await Promise.all([
      projectApi.readProjects(),
      sessionAggregateList(),
    ]);
    const projects = (projectsRaw ?? []).map(projectDataToLike);
    const sessions: ProjectSessionLike[] = (sessionResponse.sessions ?? []).map(
      toFrontendSession
    );
    const workItemsByProject: Record<string, WorkItemLike[]> = {};

    await Promise.all(
      projects.map(async (project) => {
        const slug = project.slug || project.id;
        try {
          const enriched = await projectApi.readWorkItemsEnriched(slug);
          const items = (enriched ?? []).map((item) =>
            enrichedWorkItemToUI(item)
          ) as unknown as WorkItemLike[];
          workItemsByProject[project.id] = items;
          workItemsByProject[slug] = items;
        } catch {
          workItemsByProject[project.id] = [];
          workItemsByProject[slug] = [];
        }
      })
    );

    let standaloneWorkItems: WorkItemLike[] = [];
    try {
      const standalone = await projectApi.readStandaloneWorkItems();
      standaloneWorkItems = (standalone ?? []).map((item) => {
        const anyItem = item as unknown as Record<string, unknown>;
        return {
          session_id: String(
            anyItem.session_id ?? anyItem.id ?? anyItem.short_id ?? ""
          ),
          name: String(anyItem.name ?? anyItem.title ?? "work item"),
          status: String(anyItem.status ?? ""),
          workItemStatus: String(
            anyItem.workItemStatus ?? anyItem.status ?? ""
          ),
          linkedSessions: (anyItem.linkedSessions ??
            anyItem.linked_sessions ??
            []) as WorkItemLike["linkedSessions"],
          todos: (anyItem.todos as WorkItemLike["todos"]) ?? [],
          workProducts:
            (anyItem.workProducts as WorkItemLike["workProducts"]) ??
            (anyItem.work_products as WorkItemLike["workProducts"]) ??
            [],
          created_time: String(
            anyItem.created_time ?? anyItem.created_at ?? ""
          ),
          updated_time: String(
            anyItem.updated_time ?? anyItem.updated_at ?? ""
          ),
        };
      });
    } catch {
      standaloneWorkItems = [];
    }

    // The tree is a projection of project truth. Empty or sparse real data must
    // stay visibly empty; synthetic records are available only through the
    // caller's explicit `forceDemo` action.
    return {
      tree: buildWorkspaceProjectTree({
        workspaceName: options?.workspaceName ?? "Workspace",
        projects,
        workItemsByProject,
        sessions,
        standaloneWorkItems,
      }),
      projects,
      workItemsByProject,
      sessions,
      standaloneWorkItems,
      usedDemo: false,
    };
  } catch (error) {
    return {
      tree: buildWorkspaceProjectTree({
        workspaceName: options?.workspaceName ?? "Workspace",
        projects: [],
        workItemsByProject: {},
        sessions: [],
        standaloneWorkItems: [],
      }),
      projects: [],
      workItemsByProject: {},
      sessions: [],
      standaloneWorkItems: [],
      usedDemo: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
