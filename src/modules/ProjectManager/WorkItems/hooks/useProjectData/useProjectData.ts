/**
 * useProjectData
 *
 * Loads project data from the SQLite project store (slug-keyed).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { type MemberEntry, projectApi } from "@src/api/http/project";
import { useAsyncResource } from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";
import type { ProjectData } from "@src/modules/ProjectManager/shared";
import type { Label, Person } from "@src/types/core/shared";

import type { UseProjectDataOptions, UseProjectDataReturn } from "./types";
import { useProjectDataFile } from "./useProjectDataFile";
import type { FetchFromFilesResult } from "./useProjectDataFile";

const log = createLogger("useProjectData");
const AUTO_PROJECT_SCOPE = "__auto_project__";
const EMPTY_PROJECT_DATA: FetchFromFilesResult = {
  allProjects: [],
  autoSelectedId: null,
  labels: [],
  members: [],
  project: null,
  rawMembers: [],
};

export function useProjectData(
  options: UseProjectDataOptions = {}
): UseProjectDataReturn {
  const {
    projectId: initialProjectId,
    autoLoad = true,
    isActive = true,
  } = options;
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialProjectId || null
  );
  const { fetchFromFiles, updateProjectFile } = useProjectDataFile();

  const fetchProjectData = useCallback(
    async (scopeKey: string) => {
      try {
        return await fetchFromFiles(
          scopeKey === AUTO_PROJECT_SCOPE ? null : scopeKey
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load project from store";
        log.error("[useProjectData] Load error:", error);
        throw new Error(message);
      }
    },
    [fetchFromFiles]
  );
  const {
    data,
    error,
    loading,
    refresh: loadFromFiles,
    setData: setProjectData,
  } = useAsyncResource({
    autoLoad,
    fetcher: fetchProjectData,
    initialData: EMPTY_PROJECT_DATA,
    scopeKey: selectedProjectId ?? AUTO_PROJECT_SCOPE,
  });

  const project = data.project;
  const projectRef = useRef<ProjectData | null>(project);
  projectRef.current = project;
  const availableMembers: Person[] = data.members;
  const availableLabels: Label[] = data.labels;

  useEffect(() => {
    if (initialProjectId && initialProjectId !== selectedProjectId) {
      setSelectedProjectId(initialProjectId);
    }
    // selectedProjectId is deliberately omitted: this effect mirrors prop
    // changes into the local selection without undoing a user selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProjectId]);

  useEffect(() => {
    if (data.autoSelectedId && data.autoSelectedId !== selectedProjectId) {
      setSelectedProjectId(data.autoSelectedId);
    }
  }, [data.autoSelectedId, selectedProjectId]);

  const updateProject = useCallback(
    async (updates: Partial<ProjectData>): Promise<boolean> => {
      if (!selectedProjectId) return false;

      setProjectData((current) => ({
        ...current,
        project: current.project ? { ...current.project, ...updates } : null,
      }));

      try {
        const currentProject = projectRef.current;
        if (!currentProject) return false;
        const merged = { ...currentProject, ...updates };
        await updateProjectFile(merged, updates);
        return true;
      } catch (error) {
        log.error("[useProjectData] Update error:", error);
        await loadFromFiles();
        return false;
      }
    },
    [loadFromFiles, selectedProjectId, setProjectData, updateProjectFile]
  );

  const updateMembers = useCallback(
    async (updatedMembers: MemberEntry[]) => {
      const slug = projectRef.current?.slug;
      if (!slug) return;
      setProjectData((current) => ({
        ...current,
        members: updatedMembers
          .filter((member) => member.active)
          .map((member) => ({
            id: member.id,
            name: member.name,
            email: member.email,
            avatar: member.avatar,
          })),
        rawMembers: updatedMembers,
      }));
      await projectApi.writeMembers(slug, { members: updatedMembers });
    },
    [setProjectData]
  );

  const updateLabels = useCallback(
    async (updatedLabels: Label[]) => {
      const slug = projectRef.current?.slug;
      if (!slug) return;
      setProjectData((current) => ({
        ...current,
        labels: updatedLabels,
      }));
      await projectApi.writeLabels(slug, { labels: updatedLabels });
    },
    [setProjectData]
  );

  const selectProject = useCallback((newProjectId: string) => {
    setSelectedProjectId(newProjectId);
  }, []);

  const activeLoadFromFiles = useCallback(() => {
    if (!isActive) return;
    void loadFromFiles();
  }, [isActive, loadFromFiles]);
  useProjectDataChanged(activeLoadFromFiles);

  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (isActive && !wasActiveRef.current && project !== null) {
      void loadFromFiles();
    }
    wasActiveRef.current = isActive;
  }, [isActive, loadFromFiles, project]);

  return {
    project,
    loading,
    error,
    availableMembers,
    availableTeams: [],
    availableLabels,
    availableProjects: data.allProjects,
    availableMilestones: [],
    rawMembers: data.rawMembers,
    rawLabels: data.labels,
    refresh: loadFromFiles,
    updateProject,
    updateMembers,
    updateLabels,
    selectProject,
    projects: [],
    selectedProjectId,
  };
}

export default useProjectData;
