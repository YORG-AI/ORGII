/**
 * useProjectWorkItemsTabContentWorkspaceData
 *
 * Owns the workspace work-item data source for ProjectWorkItemsTabContent:
 * fetching the active/completed buckets, on-demand completed-filter loading,
 * and the local/external workspace-source toggle. Extracted to keep the
 * tab-content component under the 600-line limit.
 */
import { useStore } from "jotai";
import isEqual from "lodash/isEqual";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { projectApi } from "@src/api/http/project";
import type {
  WorkItemReadBucket,
  WorkspaceWorkItemsData,
} from "@src/api/http/project";
import { useProjectDataChanged } from "@src/hooks/project";
import { isWorkspaceCompletedWorkItem } from "@src/modules/ProjectManager/WorkItems/workItemsViewModel";
import { loadWorkspaceLinearWorkItems } from "@src/modules/ProjectManager/workspaceAggregate";
import { StoreScopedSnapshotCache } from "@src/util/cache/storeScopedSnapshotCache";

import {
  WORKSPACE_ACTIVE_READ_BUCKET,
  WORKSPACE_COMPLETED_READ_BUCKET,
} from "./ProjectWorkItemsTabContentConstants";
import {
  mergeWorkspaceEntries,
  readWorkspaceBucket,
} from "./ProjectWorkItemsTabContentDataLoader";
import type {
  AggregatedWorkItem,
  WorkspaceSourceMode,
} from "./ProjectWorkItemsTabContentTypes";

interface UseProjectWorkItemsTabContentWorkspaceDataParams {
  orgId?: string;
  allowExternalSources: boolean;
  t: (key: string) => string;
}

interface WorkspaceProjectOption {
  id: string;
  name: string;
  slug: string;
  orgId: string;
  orgName?: string;
}

export interface ProjectWorkItemsWorkspaceSnapshot {
  workItemsByProject: AggregatedWorkItem[];
  projectOptions: WorkspaceProjectOption[];
  loaded: boolean;
  error: string | null;
  workspaceSourceMode: WorkspaceSourceMode;
  completedItemsLoaded: boolean;
}

const MAX_RETAINED_WORK_ITEM_SCOPES = 4;
const MAX_RETAINED_WORK_ITEMS = 500;
const MAX_RETAINED_PROJECT_OPTIONS = 100;
const RETAINED_WORK_ITEMS_TTL_MS = 10 * 60 * 1000;

const retainedWorkspaceSnapshots = new StoreScopedSnapshotCache<
  string,
  ProjectWorkItemsWorkspaceSnapshot
>(MAX_RETAINED_WORK_ITEM_SCOPES, RETAINED_WORK_ITEMS_TTL_MS);

interface WorkspaceBucketLoadResult {
  workspaceData: WorkspaceWorkItemsData;
  linearWorkItems: Awaited<ReturnType<typeof loadWorkspaceLinearWorkItems>>;
}

interface WorkspaceBucketLoaders {
  readWorkspace: typeof projectApi.readWorkspaceWorkItemsData;
  readLinear: typeof loadWorkspaceLinearWorkItems;
}

const workspaceBucketRequests = new Map<
  string,
  Promise<WorkspaceBucketLoadResult>
>();

export function loadWorkspaceWorkItemsBucket(
  {
    orgId,
    readBucket,
    includeExternalSources,
  }: {
    orgId?: string;
    readBucket?: WorkItemReadBucket;
    includeExternalSources: boolean;
  },
  loaders: WorkspaceBucketLoaders = {
    readWorkspace: projectApi.readWorkspaceWorkItemsData,
    readLinear: loadWorkspaceLinearWorkItems,
  }
): Promise<WorkspaceBucketLoadResult> {
  const key = JSON.stringify([
    orgId ?? null,
    readBucket ?? null,
    includeExternalSources,
  ]);
  const pending = workspaceBucketRequests.get(key);
  if (pending) return pending;

  const request = Promise.all([
    loaders.readWorkspace({ orgId, readBucket }),
    includeExternalSources ? loaders.readLinear() : Promise.resolve([]),
  ])
    .then(([workspaceData, linearWorkItems]) => ({
      workspaceData,
      linearWorkItems,
    }))
    .finally(() => {
      if (workspaceBucketRequests.get(key) === request) {
        workspaceBucketRequests.delete(key);
      }
    });
  workspaceBucketRequests.set(key, request);
  return request;
}

export function retainProjectWorkItemsWorkspaceSnapshot({
  current,
  workItemsByProject,
  projectOptions,
  loaded,
  error,
  workspaceSourceMode,
  completedItemsLoaded,
}: {
  current?: ProjectWorkItemsWorkspaceSnapshot;
  workItemsByProject: AggregatedWorkItem[];
  projectOptions: WorkspaceProjectOption[];
  loaded: boolean;
  error: string | null;
  workspaceSourceMode: WorkspaceSourceMode;
  completedItemsLoaded: boolean;
}): ProjectWorkItemsWorkspaceSnapshot {
  const next = {
    workItemsByProject: workItemsByProject.slice(0, MAX_RETAINED_WORK_ITEMS),
    projectOptions: projectOptions.slice(0, MAX_RETAINED_PROJECT_OPTIONS),
    loaded,
    error,
    workspaceSourceMode,
    completedItemsLoaded,
  };
  return current && isEqual(current, next) ? current : next;
}

function semanticStateSetter<T>(
  setValue: Dispatch<SetStateAction<T>>
): Dispatch<SetStateAction<T>> {
  return (update) => {
    setValue((current) => {
      const next =
        typeof update === "function"
          ? (update as (previous: T) => T)(current)
          : update;
      return isEqual(current, next) ? current : next;
    });
  };
}

export function useProjectWorkItemsTabContentWorkspaceData({
  orgId,
  allowExternalSources,
  t,
}: UseProjectWorkItemsTabContentWorkspaceDataParams) {
  const store = useStore();
  const retentionKey = `${orgId ?? "all-orgs"}:${allowExternalSources ? "external-allowed" : "local-only"}`;
  const retainedSnapshot = useMemo(
    () => retainedWorkspaceSnapshots.get(store, retentionKey),
    [retentionKey, store]
  );
  const [workItemsByProject, setWorkItemsByProjectState] = useState<
    AggregatedWorkItem[]
  >(() => retainedSnapshot?.workItemsByProject ?? []);
  const setWorkItemsByProject = useMemo(
    () => semanticStateSetter(setWorkItemsByProjectState),
    []
  );
  const [projectOptions, setProjectOptionsState] = useState<
    WorkspaceProjectOption[]
  >(() => retainedSnapshot?.projectOptions ?? []);
  const setProjectOptions = useMemo(
    () => semanticStateSetter(setProjectOptionsState),
    []
  );
  const [loading, setLoading] = useState(() => !retainedSnapshot?.loaded);
  const [loaded, setLoaded] = useState(() => retainedSnapshot?.loaded ?? false);
  const loadedRef = useRef(retainedSnapshot?.loaded ?? false);
  const loadGenerationRef = useRef(0);
  const completedItemsLoadedRef = useRef(
    retainedSnapshot?.completedItemsLoaded ?? false
  );
  const [completedItemsLoading, setCompletedItemsLoading] = useState(false);
  const completedItemsLoadingRef = useRef(false);
  const completedLoadGenerationRef = useRef(0);
  const [completedItemsError, setCompletedItemsError] = useState<string | null>(
    null
  );
  const [error, setError] = useState<string | null>(
    () => retainedSnapshot?.error ?? null
  );
  const [workspaceSourceMode, setWorkspaceSourceMode] =
    useState<WorkspaceSourceMode>(
      () => retainedSnapshot?.workspaceSourceMode ?? "local_only"
    );

  const includeExternalSources =
    allowExternalSources && workspaceSourceMode === "include_external";

  useEffect(() => {
    if (!loaded) return;
    const current = retainedWorkspaceSnapshots.get(store, retentionKey);
    retainedWorkspaceSnapshots.set(
      store,
      retentionKey,
      retainProjectWorkItemsWorkspaceSnapshot({
        current,
        workItemsByProject,
        projectOptions,
        loaded,
        error,
        workspaceSourceMode,
        completedItemsLoaded: completedItemsLoadedRef.current,
      })
    );
  }, [
    error,
    loaded,
    projectOptions,
    retentionKey,
    store,
    workItemsByProject,
    workspaceSourceMode,
  ]);

  useEffect(() => {
    if (!allowExternalSources) {
      setWorkspaceSourceMode("local_only");
    }
  }, [allowExternalSources]);

  const completedScopeRef = useRef(
    `${orgId ?? "all-orgs"}:${includeExternalSources}`
  );
  useEffect(() => {
    const completedScope = `${orgId ?? "all-orgs"}:${includeExternalSources}`;
    if (completedScopeRef.current === completedScope) return;
    completedScopeRef.current = completedScope;
    completedLoadGenerationRef.current += 1;
    completedItemsLoadedRef.current = false;
    completedItemsLoadingRef.current = false;
    setCompletedItemsLoading(false);
    setCompletedItemsError(null);
  }, [includeExternalSources, orgId]);

  const loadWorkItems = useCallback(
    async (
      cancelled?: () => boolean,
      options: { background?: boolean } = {}
    ) => {
      const loadGeneration = loadGenerationRef.current + 1;
      loadGenerationRef.current = loadGeneration;
      if (!options.background) setLoading(true);
      setError(null);
      try {
        const shouldLoadCompleted = completedItemsLoadedRef.current;
        const readBucket = shouldLoadCompleted
          ? undefined
          : WORKSPACE_ACTIVE_READ_BUCKET;
        const { workspaceData, linearWorkItems } =
          await loadWorkspaceWorkItemsBucket({
            orgId,
            readBucket,
            includeExternalSources,
          });
        const entries = readWorkspaceBucket({
          workspaceData,
          orgId,
          readBucket,
          linearWorkItems,
        });
        if (cancelled?.() || loadGenerationRef.current !== loadGeneration) {
          return;
        }
        const orgNameById = new Map(
          workspaceData.orgs.map((org) => [org.id, org.name])
        );
        setProjectOptions(
          workspaceData.projectEntries.map(({ project }) => ({
            id: project.meta.id,
            name: project.meta.name,
            slug: project.slug,
            orgId: project.meta.org_id,
            orgName: orgNameById.get(project.meta.org_id),
          }))
        );
        setWorkItemsByProject((currentEntries) => {
          if (shouldLoadCompleted) {
            return entries;
          }
          const completedEntriesToPreserve = completedItemsLoadedRef.current
            ? currentEntries.filter((entry) =>
                isWorkspaceCompletedWorkItem(entry.item)
              )
            : [];
          return [...entries, ...completedEntriesToPreserve];
        });
        if (shouldLoadCompleted) {
          completedItemsLoadedRef.current = true;
        }
        loadedRef.current = true;
        setLoaded(true);
      } catch (err) {
        if (cancelled?.() || loadGenerationRef.current !== loadGeneration) {
          return;
        }
        if (!loadedRef.current) {
          setWorkItemsByProject([]);
        }
        setError(
          err instanceof Error ? err.message : t("projects.loadProjectsFailed")
        );
      } finally {
        if (
          !options.background &&
          !cancelled?.() &&
          loadGenerationRef.current === loadGeneration
        ) {
          setLoading(false);
        }
      }
    },
    [includeExternalSources, orgId, setProjectOptions, setWorkItemsByProject, t]
  );

  useEffect(() => {
    let cancelled = false;
    void loadWorkItems(() => cancelled, {
      background: loadedRef.current,
    });
    return () => {
      cancelled = true;
    };
  }, [loadWorkItems]);

  useProjectDataChanged(
    useCallback(() => {
      void loadWorkItems(undefined, { background: loadedRef.current });
    }, [loadWorkItems])
  );

  const loadCompletedWorkItems = useCallback(async () => {
    if (completedItemsLoadedRef.current || completedItemsLoadingRef.current) {
      return;
    }

    completedItemsLoadingRef.current = true;
    const loadGeneration = completedLoadGenerationRef.current + 1;
    completedLoadGenerationRef.current = loadGeneration;
    setCompletedItemsLoading(true);
    setCompletedItemsError(null);
    try {
      const { workspaceData, linearWorkItems } =
        await loadWorkspaceWorkItemsBucket({
          orgId,
          readBucket: WORKSPACE_COMPLETED_READ_BUCKET,
          includeExternalSources,
        });
      const completedEntries = readWorkspaceBucket({
        workspaceData,
        orgId,
        readBucket: WORKSPACE_COMPLETED_READ_BUCKET,
        linearWorkItems,
      });
      if (completedLoadGenerationRef.current !== loadGeneration) return;
      setWorkItemsByProject((currentEntries) =>
        mergeWorkspaceEntries(currentEntries, completedEntries)
      );
      completedItemsLoadedRef.current = true;
    } catch (err) {
      if (completedLoadGenerationRef.current === loadGeneration) {
        setCompletedItemsError(
          err instanceof Error ? err.message : t("projects.loadProjectsFailed")
        );
      }
    } finally {
      if (completedLoadGenerationRef.current === loadGeneration) {
        completedItemsLoadingRef.current = false;
        setCompletedItemsLoading(false);
      }
    }
  }, [includeExternalSources, orgId, setWorkItemsByProject, t]);

  return {
    workItemsByProject,
    setWorkItemsByProject,
    projectOptions,
    loading,
    loaded,
    error,
    completedItemsLoading,
    completedItemsError,
    loadWorkItems,
    loadCompletedWorkItems,
    workspaceSourceMode,
    setWorkspaceSourceMode,
    includeExternalSources,
  };
}
