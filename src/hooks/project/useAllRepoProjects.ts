/**
 * useAllRepoProjects
 *
 * Loads every project from the global SQLite project store. Project Manager now
 * treats projects as global projects rather than repo-scoped lists.
 *
 * Listens to:
 * - projectListRefreshAtom bumps (project created/deleted)
 * - projectDataChanged signal (Tauri "orgii-data-changed" event)
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import {
  buildLabelMap,
  buildMemberMap,
  projectApi,
  projectDataToUI,
} from "@src/api/http/project";
import type { ProjectData as FileProjectData } from "@src/api/http/project";
import {
  type ProjectListEntry,
  allProjectsEntryAtom,
  updateAllProjectsEntryAtom,
} from "@src/store/project/allProjectsAtom";
import { projectListRefreshAtom } from "@src/store/project/projectAtom";

import { useProjectDataChanged } from "./useProjectDataChanged";

export interface UseAllRepoProjectsReturn {
  entry: ProjectListEntry;
  refresh: () => void;
}

export function useAllRepoProjects(): UseAllRepoProjectsReturn {
  const refreshSignal = useAtomValue(projectListRefreshAtom);
  const entry = useAtomValue(allProjectsEntryAtom);
  const updateEntry = useSetAtom(updateAllProjectsEntryAtom);
  const signalRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  const loadProjects = useCallback(async () => {
    signalRef.current.cancelled = true;
    const signal = { cancelled: false };
    signalRef.current = signal;

    updateEntry({ loading: true, error: null });

    try {
      const projectsData = await projectApi.readProjects();
      if (signal.cancelled) return;

      const enriched = await Promise.all(
        projectsData.map(async (projectData: FileProjectData) => {
          const [labelsFile, membersFile] = await Promise.all([
            projectApi.readLabels(projectData.slug),
            projectApi.readMembers(projectData.slug),
          ]);
          const labelMap = buildLabelMap(labelsFile.labels);
          const memberMap = buildMemberMap(membersFile.members);
          return projectDataToUI(projectData, { labelMap, memberMap });
        })
      );

      if (signal.cancelled) return;

      updateEntry({
        projects: enriched,
        loading: false,
        error: null,
      });
    } catch (err) {
      if (signal.cancelled) return;
      updateEntry({
        projects: [],
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [updateEntry]);

  useEffect(() => {
    loadProjects();
    return () => {
      signalRef.current.cancelled = true;
    };
  }, [loadProjects, refreshSignal]);

  useProjectDataChanged(
    useCallback(
      (change) => {
        // The global project collection contains project metadata, labels,
        // and members—not Work Item payloads. A scoped item mutation is
        // already handled by the owning list/detail surfaces and must not
        // fan out into a read of every project plus every label/member set.
        if (change?.workItemId) return;
        void loadProjects();
      },
      [loadProjects]
    )
  );

  return {
    entry,
    refresh: loadProjects,
  };
}
