/**
 * useProjectData
 *
 * Loads project data from the SQLite project store (slug-keyed).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { type MemberEntry, projectApi } from "@src/api/http/project";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";
import type { ProjectData } from "@src/modules/ProjectManager/shared";
import type { Label, Person } from "@src/types/core/shared";

import type { UseProjectDataOptions, UseProjectDataReturn } from "./types";
import { useProjectDataFile } from "./useProjectDataFile";

const log = createLogger("useProjectData");

export function useProjectData(
  options: UseProjectDataOptions = {}
): UseProjectDataReturn {
  const {
    projectId: initialProjectId,
    autoLoad = true,
    isActive = true,
  } = options;

  const [project, setProject] = useState<ProjectData | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialProjectId || null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectRef = useRef<ProjectData | null>(project);
  projectRef.current = project;
  const loadGenerationRef = useRef(0);

  const [storeMembers, setStoreMembers] = useState<Person[]>([]);
  const [storeLabels, setStoreLabels] = useState<Label[]>([]);
  const [storeProjects, setStoreProjects] = useState<
    { id: string; name: string }[]
  >([]);
  const [rawMembers, setRawMembers] = useState<MemberEntry[]>([]);
  const [rawLabels, setRawLabels] = useState<Label[]>([]);

  const file = useProjectDataFile();

  const availableMembers = storeMembers;
  const availableLabels = storeLabels;

  const loadFromFiles = useCallback(async () => {
    const loadGeneration = loadGenerationRef.current + 1;
    loadGenerationRef.current = loadGeneration;
    setLoading(true);
    setError(null);
    try {
      const result = await file.fetchFromFiles(selectedProjectId);
      if (loadGenerationRef.current !== loadGeneration) return;
      setProject(result.project);
      setStoreMembers(result.members);
      setStoreLabels(result.labels);
      setStoreProjects(result.allProjects);
      setRawMembers(result.rawMembers);
      setRawLabels(result.labels);
      if (result.autoSelectedId) {
        setSelectedProjectId(result.autoSelectedId);
      }
    } catch (err) {
      if (loadGenerationRef.current !== loadGeneration) return;
      const message =
        err instanceof Error
          ? err.message
          : "Failed to load project from store";
      setError(message);
      log.error("[useProjectData] Load error:", err);
    } finally {
      if (loadGenerationRef.current === loadGeneration) {
        setLoading(false);
      }
    }
  }, [file, selectedProjectId]);

  const updateProject = useCallback(
    async (updates: Partial<ProjectData>): Promise<boolean> => {
      if (!selectedProjectId) return false;

      setProject((prev: ProjectData | null) =>
        prev ? { ...prev, ...updates } : prev
      );

      try {
        const currentProject = projectRef.current;
        if (!currentProject) return false;
        const merged = { ...currentProject, ...updates };
        await file.updateProjectFile(merged, updates);
        return true;
      } catch (err) {
        log.error("[useProjectData] Update error:", err);
        await loadFromFiles();
        return false;
      }
    },
    [selectedProjectId, file, loadFromFiles]
  );

  const refresh = useCallback(async () => {
    await loadFromFiles();
  }, [loadFromFiles]);

  const selectProject = useCallback((newProjectId: string) => {
    setSelectedProjectId(newProjectId);
  }, []);

  const updateMembers = useCallback(async (updatedMembers: MemberEntry[]) => {
    const slug = projectRef.current?.slug;
    if (!slug) return;
    setRawMembers(updatedMembers);
    setStoreMembers(
      updatedMembers
        .filter((member) => member.active)
        .map((member) => ({
          id: member.id,
          name: member.name,
          email: member.email,
          avatar: member.avatar,
        }))
    );
    await projectApi.writeMembers(slug, {
      members: updatedMembers,
    });
  }, []);

  const updateLabels = useCallback(async (updatedLabels: Label[]) => {
    const slug = projectRef.current?.slug;
    if (!slug) return;
    setRawLabels(updatedLabels);
    setStoreLabels(updatedLabels);
    await projectApi.writeLabels(slug, {
      labels: updatedLabels,
    });
  }, []);

  useEffect(() => {
    if (initialProjectId && initialProjectId !== selectedProjectId) {
      setSelectedProjectId(initialProjectId);
    }
  }, [initialProjectId, selectedProjectId]);

  const wasActiveRef = useRef(false);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (!autoLoad || !isActive) {
      loadGenerationRef.current += 1;
      return;
    }

    const selectedProjectAlreadyLoaded =
      selectedProjectId !== null &&
      projectRef.current?.id === selectedProjectId;
    if (!wasActive || !selectedProjectAlreadyLoaded) {
      void loadFromFiles();
    }

    return () => {
      loadGenerationRef.current += 1;
    };
  }, [autoLoad, isActive, loadFromFiles, selectedProjectId]);

  const activeLoadFromFiles = useCallback(
    (
      change?: {
        projectSlug?: string;
      } | null
    ) => {
      if (!isActive) return;
      const activeProjectSlug = projectRef.current?.slug;
      if (
        change?.projectSlug &&
        activeProjectSlug &&
        change.projectSlug !== activeProjectSlug
      ) {
        return;
      }
      loadFromFiles();
    },
    [isActive, loadFromFiles]
  );

  useProjectDataChanged(activeLoadFromFiles);

  return {
    project,
    loading,
    error,
    availableMembers,
    availableTeams: [],
    availableLabels,
    availableProjects: storeProjects,
    availableMilestones: [],
    rawMembers,
    rawLabels,
    refresh,
    updateProject,
    updateMembers,
    updateLabels,
    selectProject,
    projects: [],
    selectedProjectId,
  };
}

export default useProjectData;
