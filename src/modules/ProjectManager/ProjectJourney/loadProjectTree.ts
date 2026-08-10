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
import { sessionJourneyApi } from "@src/api/tauri/sessionJourney";

import {
  DEMO_PROJECT,
  DEMO_SESSIONS,
  DEMO_WORK_ITEMS,
  type ProjectLike,
  type ProjectSessionJourneyState,
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
  journeysBySessionId: ReadonlyMap<string, ProjectSessionJourneyState>;
  usedDemo: boolean;
  error?: string;
}

export async function loadSessionJourneys(
  sessions: readonly ProjectSessionLike[]
): Promise<ReadonlyMap<string, ProjectSessionJourneyState>> {
  const results = new Map<string, ProjectSessionJourneyState>();
  const concurrency = 6;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, sessions.length) },
    async () => {
      while (cursor < sessions.length) {
        const session = sessions[cursor++];
        if (!session) continue;
        try {
          const response = await sessionJourneyApi.snapshot(session.session_id);
          results.set(session.session_id, {
            state: "ready",
            snapshot: response.snapshot,
          });
        } catch (error) {
          results.set(session.session_id, {
            state: "unavailable",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  );
  await Promise.all(workers);
  return results;
}

/**
 * Starts bounded Journey enrichment after the canonical tree is available.
 * The callback is intentionally per-session so callers can paint useful
 * project/session membership without waiting for unrelated snapshots.
 */
export function streamSessionJourneys(
  sessions: readonly ProjectSessionLike[],
  onResult: (sessionId: string, state: ProjectSessionJourneyState) => void,
  concurrency = 6
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), sessions.length) },
    async () => {
      while (cursor < sessions.length) {
        const session = sessions[cursor++];
        if (!session) continue;
        try {
          const response = await sessionJourneyApi.snapshot(session.session_id);
          onResult(session.session_id, {
            state: "ready",
            snapshot: response.snapshot,
          });
        } catch (error) {
          onResult(session.session_id, {
            state: "unavailable",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  );
  return Promise.all(workers).then(() => undefined);
}

export async function loadSessionJourney(
  sessionId: string
): Promise<ProjectSessionJourneyState> {
  try {
    const response = await sessionJourneyApi.snapshot(sessionId);
    return { state: "ready", snapshot: response.snapshot };
  } catch (error) {
    return {
      state: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
    const journeysBySessionId = new Map<string, ProjectSessionJourneyState>();
    return {
      tree: buildWorkspaceProjectTree({
        workspaceName: options.workspaceName ?? "Workspace",
        projects: [DEMO_PROJECT],
        workItemsByProject,
        sessions: DEMO_SESSIONS,
        journeysBySessionId,
      }),
      projects: [DEMO_PROJECT],
      workItemsByProject,
      sessions: DEMO_SESSIONS,
      standaloneWorkItems: [],
      journeysBySessionId,
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
    const journeysBySessionId = new Map<string, ProjectSessionJourneyState>();

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
        journeysBySessionId,
        standaloneWorkItems,
      }),
      projects,
      workItemsByProject,
      sessions,
      standaloneWorkItems,
      journeysBySessionId,
      usedDemo: false,
    };
  } catch (error) {
    return {
      tree: buildWorkspaceProjectTree({
        workspaceName: options?.workspaceName ?? "Workspace",
        projects: [],
        workItemsByProject: {},
        sessions: [],
        journeysBySessionId: new Map(),
        standaloneWorkItems: [],
      }),
      projects: [],
      workItemsByProject: {},
      sessions: [],
      standaloneWorkItems: [],
      journeysBySessionId: new Map(),
      usedDemo: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
