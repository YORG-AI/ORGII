/**
 * useProjectWorkItemsTabContentWorkspaceData
 *
 * Owns the workspace work-item data source for ProjectWorkItemsTabContent:
 * fetching the active/completed buckets, incremental "completed" section
 * loading, and the local/external workspace-source toggle. Extracted to
 * keep the tab-content component under the 600-line limit.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { projectApi } from "@src/api/http/project";
import { useProjectDataChanged } from "@src/hooks/project";
import { isWorkspaceCompletedWorkItem } from "@src/modules/ProjectManager/WorkItems/workItemsViewModel";
import { loadWorkspaceLinearWorkItems } from "@src/modules/ProjectManager/workspaceAggregate";

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

export function useProjectWorkItemsTabContentWorkspaceData({
  orgId,
  allowExternalSources,
  t,
}: UseProjectWorkItemsTabContentWorkspaceDataParams) {
  const [workItemsByProject, setWorkItemsByProject] = useState<
    AggregatedWorkItem[]
  >([]);
  const [projectOptions, setProjectOptions] = useState<
    Array<{
      id: string;
      name: string;
      slug: string;
      orgId: string;
      orgName?: string;
    }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const completedItemsLoadedRef = useRef(false);
  const completedSectionExpandedRef = useRef(false);
  const [completedItemsLoading, setCompletedItemsLoading] = useState(false);
  const completedItemsLoadingRef = useRef(false);
  const completedLoadGenerationRef = useRef(0);
  const [completedItemsError, setCompletedItemsError] = useState<string | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [workspaceSourceMode, setWorkspaceSourceMode] =
    useState<WorkspaceSourceMode>("local_only");

  const includeExternalSources =
    allowExternalSources && workspaceSourceMode === "include_external";

  useEffect(() => {
    if (!allowExternalSources) {
      setWorkspaceSourceMode("local_only");
    }
  }, [allowExternalSources]);

  useEffect(() => {
    completedLoadGenerationRef.current += 1;
    completedItemsLoadedRef.current = false;
    completedItemsLoadingRef.current = false;
    setCompletedItemsLoading(false);
    setCompletedItemsError(null);
  }, [includeExternalSources, orgId]);

  const loadWorkItems = useCallback(
    async (cancelled?: () => boolean) => {
      setLoading(true);
      setError(null);
      try {
        const [projects, orgs, linearWorkItems] = await Promise.all([
          projectApi.readProjects({ orgId }),
          projectApi.readOrgs(),
          includeExternalSources ? loadWorkspaceLinearWorkItems() : [],
        ]);
        const orgNameById = new Map(orgs.map((org) => [org.id, org.name]));
        const shouldLoadCompleted =
          completedItemsLoadedRef.current ||
          completedSectionExpandedRef.current;
        const [activeEntries, completedEntries] = await Promise.all([
          readWorkspaceBucket({
            projects,
            orgNameById,
            orgId,
            readBucket: WORKSPACE_ACTIVE_READ_BUCKET,
            linearWorkItems,
          }),
          shouldLoadCompleted
            ? readWorkspaceBucket({
                projects,
                orgNameById,
                orgId,
                readBucket: WORKSPACE_COMPLETED_READ_BUCKET,
                linearWorkItems,
              })
            : Promise.resolve([]),
        ]);
        if (cancelled?.()) return;
        setProjectOptions(
          projects.map((project) => ({
            id: project.meta.id,
            name: project.meta.name,
            slug: project.slug,
            orgId: project.meta.org_id,
            orgName: orgNameById.get(project.meta.org_id),
          }))
        );
        setWorkItemsByProject((currentEntries) => {
          if (shouldLoadCompleted) {
            return [...activeEntries, ...completedEntries];
          }
          const completedEntriesToPreserve = completedItemsLoadedRef.current
            ? currentEntries.filter((entry) =>
                isWorkspaceCompletedWorkItem(entry.item)
              )
            : [];
          return [...activeEntries, ...completedEntriesToPreserve];
        });
        if (shouldLoadCompleted) {
          completedItemsLoadedRef.current = true;
        }
        loadedRef.current = true;
        setLoaded(true);
      } catch (err) {
        if (cancelled?.()) return;
        if (!loadedRef.current) {
          setWorkItemsByProject([]);
        }
        setError(
          err instanceof Error ? err.message : t("projects.loadProjectsFailed")
        );
      } finally {
        if (!cancelled?.()) setLoading(false);
      }
    },
    [includeExternalSources, orgId, t]
  );

  useEffect(() => {
    let cancelled = false;
    void loadWorkItems(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadWorkItems]);

  useProjectDataChanged(
    useCallback(() => {
      void loadWorkItems();
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
      const [projects, orgs, linearWorkItems] = await Promise.all([
        projectApi.readProjects({ orgId }),
        projectApi.readOrgs(),
        includeExternalSources ? loadWorkspaceLinearWorkItems() : [],
      ]);
      const orgNameById = new Map(orgs.map((org) => [org.id, org.name]));
      const completedEntries = await readWorkspaceBucket({
        projects,
        orgNameById,
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
  }, [includeExternalSources, orgId, t]);

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
    completedSectionExpandedRef,
    workspaceSourceMode,
    setWorkspaceSourceMode,
    includeExternalSources,
  };
}
