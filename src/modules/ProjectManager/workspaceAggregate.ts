import {
  STORY_SYNC_ADAPTER,
  syncConnectionsApi,
} from "@src/api/http/integrations";
import type {
  LinearIssueSummary,
  LinearProjectSummary,
  SyncConnection,
} from "@src/api/http/integrations";
import type {
  Project,
  ProjectPriority,
  ProjectStatus,
} from "@src/types/core/project";
import type { WorkItem } from "@src/types/core/workItem";
import { mapWithConcurrency } from "@src/util/collections/mapWithConcurrency";

import { cachedLinearProjectsApi } from "./LinearProjects/linearProjectsCache";
import { linearIssueToWorkItem } from "./LinearProjects/utils";

const LINEAR_PROJECT_STATUS_TYPE_TO_STORY_STATUS: Record<
  string,
  ProjectStatus
> = {
  backlog: "backlog",
  planned: "planned",
  unstarted: "planned",
  started: "in_progress",
  active: "in_progress",
  completed: "completed",
  done: "completed",
  canceled: "canceled",
  cancelled: "canceled",
};
const LINEAR_CONNECTION_CONCURRENCY = 2;
const LINEAR_PROJECT_CONCURRENCY = 4;

export const WORKSPACE_SOURCE = {
  LOCAL: "local",
  LINEAR: "linear",
} as const;

export type WorkspaceSource =
  (typeof WORKSPACE_SOURCE)[keyof typeof WORKSPACE_SOURCE];

export interface LinearWorkspaceSource {
  source: typeof WORKSPACE_SOURCE.LINEAR;
  connectionId: string;
  projectId: string;
  projectName: string;
  teamId?: string;
  teamName?: string;
  issueId?: string;
}

export type WorkspaceProject = Project & {
  workspaceSource?: LinearWorkspaceSource;
};

export type WorkspaceWorkItem = WorkItem & {
  workspaceSource?: LinearWorkspaceSource;
};

interface LinearWorkspaceProjectRecord {
  connection: SyncConnection;
  project: LinearProjectSummary;
}

function getProjectStatusForLinearProject(
  project: LinearProjectSummary
): ProjectStatus {
  if (project.archived_at) return "completed";
  const linearStatus = project.status?.type;
  return (
    LINEAR_PROJECT_STATUS_TYPE_TO_STORY_STATUS[linearStatus ?? ""] ?? "backlog"
  );
}

function getProjectPrimaryTeam(project: LinearProjectSummary) {
  return project.teams[0];
}

function linearProjectToWorkspaceProject(
  record: LinearWorkspaceProjectRecord
): WorkspaceProject {
  const team = getProjectPrimaryTeam(record.project);
  return {
    id: `linear:${record.connection.id}:${record.project.id}`,
    name: record.project.name,
    slug: record.project.slug_id ?? record.project.id,
    description: record.project.description ?? "",
    status: getProjectStatusForLinearProject(record.project),
    priority: "none" as ProjectPriority,
    health: "on_track",
    targetDate: record.project.target_date,
    createdAt: record.project.created_at ?? "",
    updatedAt: record.project.updated_at ?? "",
    workItemCount: undefined,
    workspaceSource: {
      source: WORKSPACE_SOURCE.LINEAR,
      connectionId: record.connection.id,
      projectId: record.project.id,
      projectName: record.project.name,
      teamId: team?.id,
      teamName: team?.name,
    },
  };
}

function linearIssueToWorkspaceWorkItem(
  issue: LinearIssueSummary,
  record: LinearWorkspaceProjectRecord
): WorkspaceWorkItem {
  const team = issue.team ?? getProjectPrimaryTeam(record.project);
  const workItem = linearIssueToWorkItem(issue, record.project);
  return {
    ...workItem,
    session_id: `linear:${record.connection.id}:${issue.id}`,
    project: {
      id: record.project.id,
      name: record.project.name,
    },
    workspaceSource: {
      source: WORKSPACE_SOURCE.LINEAR,
      connectionId: record.connection.id,
      projectId: record.project.id,
      projectName: record.project.name,
      teamId: team?.id,
      teamName: team?.name,
      issueId: issue.id,
    },
  };
}

async function loadLinearWorkspaceProjects(): Promise<
  LinearWorkspaceProjectRecord[]
> {
  const connections = await syncConnectionsApi.list();
  const linearConnections = connections.filter(
    (connection) => connection.adapter_id === STORY_SYNC_ADAPTER.LINEAR
  );
  const projectGroups = await mapWithConcurrency(
    linearConnections,
    LINEAR_CONNECTION_CONCURRENCY,
    async (connection) => {
      const result = await cachedLinearProjectsApi.listProjects(connection.id);
      return result.projects.map((project) => ({ connection, project }));
    }
  );
  return projectGroups.flat();
}

export async function loadWorkspaceLinearProjects(): Promise<
  WorkspaceProject[]
> {
  const records = await loadLinearWorkspaceProjects();
  return records.map(linearProjectToWorkspaceProject);
}

export async function loadWorkspaceLinearWorkItems(): Promise<
  WorkspaceWorkItem[]
> {
  const records = await loadLinearWorkspaceProjects();
  const issueGroups = await mapWithConcurrency(
    records,
    LINEAR_PROJECT_CONCURRENCY,
    async (record) => {
      const result = await cachedLinearProjectsApi.listProjectIssues(
        record.connection.id,
        record.project.id
      );
      return result.issues.map((issue) =>
        linearIssueToWorkspaceWorkItem(issue, record)
      );
    }
  );
  return issueGroups.flat();
}
