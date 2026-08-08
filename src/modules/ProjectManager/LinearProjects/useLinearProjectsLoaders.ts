import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
} from "react";

import type {
  LinearIssueSummary,
  LinearProjectSummary,
  LinearTeamSummary,
  LinearWorkflowStateSummary,
} from "@src/api/http/integrations";

import { cachedLinearProjectsApi } from "./linearProjectsCache";
import { errorMessage } from "./utils";

type Translate = (key: string) => string;

interface UseLinearProjectsLoadersOptions {
  connectionId?: string;
  projectId?: string;
  project: LinearProjectSummary | null;
  isActive: boolean;
  t: Translate;
  setProject: Dispatch<SetStateAction<LinearProjectSummary | null>>;
  setTeams: Dispatch<SetStateAction<LinearTeamSummary[]>>;
  setWorkflowStates: Dispatch<SetStateAction<LinearWorkflowStateSummary[]>>;
  setIssues: Dispatch<SetStateAction<LinearIssueSummary[]>>;
  setLoadingProject: Dispatch<SetStateAction<boolean>>;
  setLoadingIssues: Dispatch<SetStateAction<boolean>>;
  setLoadingWorkflowStates: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

interface LinearProjectsLoaders {
  loadProject: (forceRefresh?: boolean) => Promise<void>;
  loadIssues: (forceRefresh?: boolean) => Promise<void>;
  loadWorkflowStates: (forceRefresh?: boolean) => Promise<void>;
  handleRefresh: () => void;
}

export function useLinearProjectsLoaders({
  connectionId,
  projectId,
  project,
  isActive,
  t,
  setProject,
  setTeams,
  setWorkflowStates,
  setIssues,
  setLoadingProject,
  setLoadingIssues,
  setLoadingWorkflowStates,
  setError,
}: UseLinearProjectsLoadersOptions): LinearProjectsLoaders {
  const projectLoadGenerationRef = useRef(0);
  const issuesLoadGenerationRef = useRef(0);
  const workflowLoadGenerationRef = useRef(0);

  const loadProject = useCallback(
    async (forceRefresh = false) => {
      if (!isActive) return;
      const generation = projectLoadGenerationRef.current + 1;
      projectLoadGenerationRef.current = generation;
      if (!connectionId) {
        setProject(null);
        setTeams([]);
        return;
      }
      setLoadingProject(true);
      setError(null);
      try {
        const teamResult = await cachedLinearProjectsApi.listTeams(
          connectionId,
          {
            forceRefresh,
          }
        );
        if (projectLoadGenerationRef.current !== generation) return;
        setTeams(teamResult.teams);
        if (projectId) {
          const nextProject = await cachedLinearProjectsApi.getProject(
            connectionId,
            projectId,
            { forceRefresh }
          );
          if (projectLoadGenerationRef.current !== generation) return;
          setProject(nextProject);
        } else {
          setProject(null);
        }
      } catch (err) {
        if (projectLoadGenerationRef.current !== generation) return;
        setProject(null);
        setTeams([]);
        setError(errorMessage(err, t("linearProjects.errors.loadProjects")));
      } finally {
        if (projectLoadGenerationRef.current === generation) {
          setLoadingProject(false);
        }
      }
    },
    [
      connectionId,
      isActive,
      projectId,
      setError,
      setLoadingProject,
      setProject,
      setTeams,
      t,
    ]
  );

  const loadIssues = useCallback(
    async (forceRefresh = false) => {
      if (!isActive) return;
      const generation = issuesLoadGenerationRef.current + 1;
      issuesLoadGenerationRef.current = generation;
      if (!connectionId || !projectId) {
        setIssues([]);
        return;
      }
      setLoadingIssues(true);
      setError(null);
      try {
        const result = await cachedLinearProjectsApi.listProjectIssues(
          connectionId,
          projectId,
          { forceRefresh }
        );
        if (issuesLoadGenerationRef.current !== generation) return;
        setIssues(result.issues);
      } catch (err) {
        if (issuesLoadGenerationRef.current !== generation) return;
        setIssues([]);
        setError(errorMessage(err, t("linearProjects.errors.loadIssues")));
      } finally {
        if (issuesLoadGenerationRef.current === generation) {
          setLoadingIssues(false);
        }
      }
    },
    [
      connectionId,
      isActive,
      projectId,
      setError,
      setIssues,
      setLoadingIssues,
      t,
    ]
  );

  const loadWorkflowStates = useCallback(
    async (forceRefresh = false) => {
      if (!isActive) return;
      const generation = workflowLoadGenerationRef.current + 1;
      workflowLoadGenerationRef.current = generation;
      const teamId = project?.teams[0]?.id;
      if (!connectionId || !teamId) {
        setWorkflowStates([]);
        return;
      }
      setLoadingWorkflowStates(true);
      setError(null);
      try {
        const result = await cachedLinearProjectsApi.listWorkflowStates(
          connectionId,
          teamId,
          { forceRefresh }
        );
        if (workflowLoadGenerationRef.current !== generation) return;
        setWorkflowStates(result.states.filter((state) => !state.archived_at));
      } catch (err) {
        if (workflowLoadGenerationRef.current !== generation) return;
        setWorkflowStates([]);
        setError(
          errorMessage(err, t("linearProjects.errors.loadWorkflowStates"))
        );
      } finally {
        if (workflowLoadGenerationRef.current === generation) {
          setLoadingWorkflowStates(false);
        }
      }
    },
    [
      connectionId,
      isActive,
      project?.teams,
      setError,
      setLoadingWorkflowStates,
      setWorkflowStates,
      t,
    ]
  );

  const handleRefresh = useCallback(() => {
    void loadProject(true);
    void loadIssues(true);
    void loadWorkflowStates(true);
  }, [loadIssues, loadProject, loadWorkflowStates]);

  useEffect(() => {
    if (isActive) return;
    projectLoadGenerationRef.current += 1;
    issuesLoadGenerationRef.current += 1;
    workflowLoadGenerationRef.current += 1;
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;
    void loadProject();
  }, [isActive, loadProject]);

  useEffect(() => {
    if (!isActive) return;
    void loadIssues();
  }, [isActive, loadIssues]);

  useEffect(() => {
    if (!isActive) return;
    void loadWorkflowStates();
  }, [isActive, loadWorkflowStates]);

  return {
    loadProject,
    loadIssues,
    loadWorkflowStates,
    handleRefresh,
  };
}
