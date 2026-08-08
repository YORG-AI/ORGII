import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  LinearIssueSummary,
  LinearProjectSummary,
  LinearProjectUpdateRequest,
  LinearTeamSummary,
  LinearWorkflowStateCreateRequest,
  LinearWorkflowStateSummary,
  LinearWorkflowStateUpdateRequest,
} from "@src/api/http/integrations";
import type { WorkItemExternalStatusConfig } from "@src/modules/ProjectManager/WorkItems/components/WorkItemProperties/types";
import type { WorkItemsViewTab } from "@src/modules/ProjectManager/WorkItems/components/WorkItemsPageHeader";
import {
  type StatusFilterType,
  WORK_ITEMS_DEFAULT_STATUS,
} from "@src/modules/ProjectManager/WorkItems/types";
import {
  countWorkItemsByStatus,
  getWorkItemNavigation,
  groupWorkItemsForStatusFilter,
} from "@src/modules/ProjectManager/WorkItems/workItemsViewModel";
import type { DropdownOption } from "@src/types/core/shared";
import type { WorkItem, WorkItemStatus } from "@src/types/core/workItem";

import {
  EMPTY_ISSUE_DRAFT,
  EMPTY_PROJECT_DRAFT,
  type IssueDraft,
  type ProjectDraft,
} from "./types";
import { useLinearProjectsDerivedState } from "./useLinearProjectsDerivedState";
import { useLinearProjectsLoaders } from "./useLinearProjectsLoaders";
import { useLinearProjectsMutations } from "./useLinearProjectsMutations";

interface UseLinearProjectsDataOptions {
  connectionId?: string;
  projectId?: string;
  isActive?: boolean;
}

export interface LinearProjectsData {
  project: LinearProjectSummary | null;
  teams: LinearTeamSummary[];
  workflowStates: LinearWorkflowStateSummary[];
  issues: LinearIssueSummary[];
  workItems: WorkItem[];
  filteredWorkItems: WorkItem[];
  groupedWorkItems: ReturnType<typeof groupWorkItemsForStatusFilter>;
  statusCounts: ReturnType<typeof countWorkItemsByStatus>;
  navigation: ReturnType<typeof getWorkItemNavigation>;
  selectedWorkItem: WorkItem | null;
  selectedIssue: LinearIssueSummary | null;
  issueStateIdsById: Map<string, string>;
  linearStatusOptions: DropdownOption<string>[];
  linearIssueStatusConfig: WorkItemExternalStatusConfig | undefined;

  loadingProject: boolean;
  loadingIssues: boolean;
  loadingWorkflowStates: boolean;
  savingProject: boolean;
  savingIssue: boolean;
  savingWorkflowStateId: string | null;
  error: string | null;
  creatingProject: boolean;
  selectedIssueId: string | null;
  activeTab: WorkItemsViewTab;
  statusFilter: StatusFilterType;
  projectDraft: ProjectDraft;
  issueDraft: IssueDraft;

  setSelectedIssueId: (id: string | null) => void;
  setActiveTab: (tab: WorkItemsViewTab) => void;
  setStatusFilter: (filter: StatusFilterType) => void;
  setProjectDraft: (draft: ProjectDraft) => void;
  setIssueDraft: (draft: IssueDraft) => void;
  setCreatingProject: (creating: boolean) => void;

  handleRefresh: () => void;
  handleTabChange: (tab: WorkItemsViewTab) => void;
  handleNavigate: (direction: "prev" | "next") => void;
  handleAddIssueFromTabBar: () => void;
  loadWorkflowStates: () => Promise<void>;

  handleCreateProject: () => Promise<void>;
  handleUpdateProject: (updates: LinearProjectUpdateRequest) => Promise<void>;
  handleCreateIssueForStatus: (status: WorkItemStatus) => Promise<void>;
  handleUpdateIssue: (
    issueId: string,
    updates: Partial<WorkItem>
  ) => Promise<void>;
  handleUpdateIssueWorkflowState: (
    issueId: string,
    stateId: string
  ) => Promise<void>;
  handleArchiveIssue: (issueId: string) => Promise<void>;
  handleCreateWorkflowState: (
    request: LinearWorkflowStateCreateRequest
  ) => Promise<void>;
  handleUpdateWorkflowState: (
    stateId: string,
    request: LinearWorkflowStateUpdateRequest
  ) => Promise<void>;
  handleArchiveWorkflowState: (stateId: string) => Promise<void>;
}

export function useLinearProjectsData({
  connectionId,
  projectId,
  isActive = true,
}: UseLinearProjectsDataOptions): LinearProjectsData {
  const { t } = useTranslation(["projects", "common"]);

  const [project, setProject] = useState<LinearProjectSummary | null>(null);
  const [teams, setTeams] = useState<LinearTeamSummary[]>([]);
  const [workflowStates, setWorkflowStates] = useState<
    LinearWorkflowStateSummary[]
  >([]);
  const [issues, setIssues] = useState<LinearIssueSummary[]>([]);
  const [loadingProject, setLoadingProject] = useState(false);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [loadingWorkflowStates, setLoadingWorkflowStates] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [savingIssue, setSavingIssue] = useState(false);
  const [savingWorkflowStateId, setSavingWorkflowStateId] = useState<
    string | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkItemsViewTab>("Overview");
  const [statusFilter, setStatusFilter] = useState<StatusFilterType>("all");
  const [projectDraft, setProjectDraft] =
    useState<ProjectDraft>(EMPTY_PROJECT_DRAFT);
  const [issueDraft, setIssueDraft] = useState<IssueDraft>(EMPTY_ISSUE_DRAFT);
  const loadedProjectIdRef = useRef<string | null>(null);

  const { loadIssues, loadWorkflowStates, handleRefresh } =
    useLinearProjectsLoaders({
      connectionId,
      projectId,
      isActive,
      project,
      t,
      setProject,
      setTeams,
      setWorkflowStates,
      setIssues,
      setLoadingProject,
      setLoadingIssues,
      setLoadingWorkflowStates,
      setError,
    });

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (!project) {
        loadedProjectIdRef.current = null;
        setProjectDraft({
          ...EMPTY_PROJECT_DRAFT,
          teamId: teams[0]?.id ?? "",
        });
        setWorkflowStates([]);
        setSelectedIssueId(null);
        return;
      }

      const projectChanged = loadedProjectIdRef.current !== project.id;
      loadedProjectIdRef.current = project.id;

      setProjectDraft({
        name: project.name,
        description: project.description ?? "",
        teamId: project.teams[0]?.id ?? teams[0]?.id ?? "",
      });
      setCreatingProject(false);

      if (projectChanged) {
        setSelectedIssueId(null);
        setIssueDraft(EMPTY_ISSUE_DRAFT);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [project, teams]);

  const handleTabChange = useCallback((tab: WorkItemsViewTab) => {
    setActiveTab(tab);
    if (tab !== "List") setSelectedIssueId(null);
  }, []);

  const mutations = useLinearProjectsMutations({
    connectionId,
    projectId,
    project,
    workflowStates,
    projectDraft,
    issueDraft,
    t,
    loadIssues,
    setProject,
    setIssues,
    setWorkflowStates,
    setSavingProject,
    setSavingIssue,
    setSavingWorkflowStateId,
    setError,
    setCreatingProject,
    setSelectedIssueId,
    setIssueDraft,
  });

  const {
    handleCreateProject,
    handleUpdateProject,
    handleCreateIssueForStatus,
    handleUpdateIssue,
    handleUpdateIssueWorkflowState,
    handleArchiveIssue,
    handleCreateWorkflowState,
    handleUpdateWorkflowState,
    handleArchiveWorkflowState,
  } = mutations;

  const derivedState = useLinearProjectsDerivedState({
    project,
    issues,
    workflowStates,
    statusFilter,
    selectedIssueId,
    loadingWorkflowStates,
    savingIssue,
    handleUpdateIssueWorkflowState,
  });

  const { filteredWorkItems, navigation } = derivedState;

  const handleNavigate = useCallback(
    (direction: "prev" | "next") => {
      const nextIndex =
        direction === "prev"
          ? navigation.currentIndex - 1
          : navigation.currentIndex + 1;
      if (nextIndex >= 0 && nextIndex < filteredWorkItems.length) {
        setSelectedIssueId(filteredWorkItems[nextIndex].session_id);
      }
    },
    [filteredWorkItems, navigation.currentIndex]
  );

  const handleAddIssueFromTabBar = useCallback(() => {
    void handleCreateIssueForStatus(WORK_ITEMS_DEFAULT_STATUS);
  }, [handleCreateIssueForStatus]);

  return {
    project,
    teams,
    workflowStates,
    issues,
    ...derivedState,

    loadingProject,
    loadingIssues,
    loadingWorkflowStates,
    savingProject,
    savingIssue,
    savingWorkflowStateId,
    error,
    creatingProject,
    selectedIssueId,
    activeTab,
    statusFilter,
    projectDraft,
    issueDraft,

    setSelectedIssueId,
    setActiveTab,
    setStatusFilter,
    setProjectDraft,
    setIssueDraft,
    setCreatingProject,

    handleRefresh,
    handleTabChange,
    handleNavigate,
    handleAddIssueFromTabBar,
    loadWorkflowStates,

    handleCreateProject,
    handleUpdateProject,
    handleCreateIssueForStatus,
    handleUpdateIssue,
    handleUpdateIssueWorkflowState,
    handleArchiveIssue,
    handleCreateWorkflowState,
    handleUpdateWorkflowState,
    handleArchiveWorkflowState,
  };
}
