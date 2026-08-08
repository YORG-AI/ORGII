import { linearProjectsApi } from "@src/api/http/integrations";
import type {
  LinearIssueListResult,
  LinearProjectListResult,
  LinearProjectSummary,
  LinearTeamListResult,
  LinearWorkflowStateListResult,
} from "@src/api/http/integrations";

const MAX_LINEAR_PROJECTS_CACHE_ENTRIES = 120;
export const LINEAR_PROJECTS_CACHE_TTL_MS = 10 * 60 * 1000;

interface LinearCacheEntry<T> {
  value?: T;
  promise?: Promise<T>;
  cachedAt?: number;
}

const linearProjectsCache = new Map<string, LinearCacheEntry<unknown>>();

function trimCache(): void {
  while (linearProjectsCache.size > MAX_LINEAR_PROJECTS_CACHE_ENTRIES) {
    const oldestKey = linearProjectsCache.keys().next().value;
    if (!oldestKey) return;
    linearProjectsCache.delete(oldestKey);
  }
}

async function readCached<T>(
  key: string,
  loader: () => Promise<T>,
  forceRefresh = false
): Promise<T> {
  const existing = linearProjectsCache.get(key) as
    | LinearCacheEntry<T>
    | undefined;
  if (existing?.promise) return existing.promise;

  if (!forceRefresh) {
    if (
      existing?.value !== undefined &&
      typeof existing.cachedAt === "number" &&
      Date.now() - existing.cachedAt < LINEAR_PROJECTS_CACHE_TTL_MS
    ) {
      return existing.value;
    }
  }

  const promise = loader()
    .then((value) => {
      linearProjectsCache.set(key, { value, cachedAt: Date.now() });
      trimCache();
      return value;
    })
    .catch((error: unknown) => {
      const existing = linearProjectsCache.get(key) as
        | LinearCacheEntry<T>
        | undefined;
      if (existing?.promise === promise) {
        linearProjectsCache.delete(key);
      }
      throw error;
    });

  linearProjectsCache.set(key, { promise });
  trimCache();
  return promise;
}

function deleteCacheKey(key: string): void {
  linearProjectsCache.delete(key);
}

function deleteCachePrefix(prefix: string): void {
  for (const key of linearProjectsCache.keys()) {
    if (key.startsWith(prefix)) linearProjectsCache.delete(key);
  }
}

function projectsListKey(connectionId: string): string {
  return `linear:projects:${connectionId}`;
}

function teamsKey(connectionId: string): string {
  return `linear:teams:${connectionId}`;
}

function projectKey(connectionId: string, projectId: string): string {
  return `linear:project:${connectionId}:${projectId}`;
}

function projectIssuesKey(connectionId: string, projectId: string): string {
  return `linear:project-issues:${connectionId}:${projectId}`;
}

function workflowStatesKey(connectionId: string, teamId: string): string {
  return `linear:workflow-states:${connectionId}:${teamId}`;
}

export const cachedLinearProjectsApi = {
  listProjects(
    connectionId: string,
    options: { forceRefresh?: boolean } = {}
  ): Promise<LinearProjectListResult> {
    return readCached(
      projectsListKey(connectionId),
      () =>
        linearProjectsApi.listProjects(
          connectionId,
          null,
          options.forceRefresh
        ),
      options.forceRefresh
    );
  },

  listTeams(
    connectionId: string,
    options: { forceRefresh?: boolean } = {}
  ): Promise<LinearTeamListResult> {
    return readCached(
      teamsKey(connectionId),
      () =>
        linearProjectsApi.listTeams(connectionId, null, options.forceRefresh),
      options.forceRefresh
    );
  },

  getProject(
    connectionId: string,
    projectId: string,
    options: { forceRefresh?: boolean } = {}
  ): Promise<LinearProjectSummary> {
    return readCached(
      projectKey(connectionId, projectId),
      () =>
        linearProjectsApi.getProject(
          connectionId,
          projectId,
          options.forceRefresh
        ),
      options.forceRefresh
    );
  },

  listProjectIssues(
    connectionId: string,
    projectId: string,
    options: { forceRefresh?: boolean } = {}
  ): Promise<LinearIssueListResult> {
    return readCached(
      projectIssuesKey(connectionId, projectId),
      () =>
        linearProjectsApi.listProjectIssues(
          connectionId,
          projectId,
          null,
          options.forceRefresh
        ),
      options.forceRefresh
    );
  },

  listWorkflowStates(
    connectionId: string,
    teamId: string,
    options: { forceRefresh?: boolean } = {}
  ): Promise<LinearWorkflowStateListResult> {
    return readCached(
      workflowStatesKey(connectionId, teamId),
      () =>
        linearProjectsApi.listWorkflowStates(
          connectionId,
          teamId,
          options.forceRefresh
        ),
      options.forceRefresh
    );
  },

  rememberProject(connectionId: string, project: LinearProjectSummary): void {
    linearProjectsCache.set(projectKey(connectionId, project.id), {
      value: project,
      cachedAt: Date.now(),
    });
    deleteCacheKey(projectsListKey(connectionId));
    trimCache();
  },

  invalidateProjects(connectionId: string): void {
    deleteCacheKey(projectsListKey(connectionId));
  },

  invalidateProject(connectionId: string, projectId: string): void {
    deleteCacheKey(projectKey(connectionId, projectId));
    deleteCacheKey(projectsListKey(connectionId));
  },

  invalidateProjectIssues(connectionId: string, projectId: string): void {
    deleteCacheKey(projectIssuesKey(connectionId, projectId));
  },

  invalidateWorkflowStates(connectionId: string, teamId: string): void {
    deleteCacheKey(workflowStatesKey(connectionId, teamId));
  },

  invalidateConnection(connectionId: string): void {
    deleteCachePrefix(`linear:projects:${connectionId}`);
    deleteCachePrefix(`linear:teams:${connectionId}`);
    deleteCachePrefix(`linear:project:${connectionId}:`);
    deleteCachePrefix(`linear:project-issues:${connectionId}:`);
    deleteCachePrefix(`linear:workflow-states:${connectionId}:`);
  },
};
