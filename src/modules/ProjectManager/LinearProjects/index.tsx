import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Select from "@src/components/Select";
import type { WorkstationTabHeaderHost } from "@src/hooks/workStation";
import WorkItemDetail, {
  WORK_ITEM_DETAIL_SURFACE,
} from "@src/modules/ProjectManager/WorkItems/components/WorkItemDetail";
import WorkItemsPageHeader from "@src/modules/ProjectManager/WorkItems/components/WorkItemsPageHeader";
import { useProjectManagerWorkItemsTabBarRegistration } from "@src/modules/ProjectManager/hooks/useProjectManagerWorkItemsTabBarRegistration";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import {
  getProjectLinearProjectsTabChrome,
  getProjectLinearWorkItemsTabChrome,
} from "@src/store/workstation";

import type { EmbeddedWorkItemDetailState } from "../WorkItems";
import {
  LinearProjectCreateView,
  LinearProjectSelectedContent,
  LinearProjectsIndexProjectsView,
  LinearProjectsIndexWorkItemsView,
} from "./LinearProjectsPageSections";
import LinearProjectInfoPage from "./components/LinearProjectInfoPage/index";
import LinearProjectSettings from "./components/LinearProjectSettings/index";
import { useLinearIndexData } from "./useLinearIndexData";
import { useLinearProjectsData } from "./useLinearProjectsData";

interface LinearProjectsPageProps {
  surface?: "projects" | "work-items";
  connectionId?: string;
  projectId?: string;
  projectName?: string;
  teamId?: string;
  teamName?: string;
  workStationTabId?: string;
  repoPath?: string | null;
  workstationHeaderHost?: WorkstationTabHeaderHost;
  isActive?: boolean;
  onCreateProject?: () => void;
  onCreateWorkItem?: () => void;
  breadcrumbSegments?: readonly { label: string }[];
  linearSurfaceControls?: React.ReactNode;
  onOpenLinearProject?: (selection: {
    connectionId: string;
    projectId: string;
    projectName: string;
    teamId?: string;
    teamName?: string;
  }) => void;
  onEmbeddedWorkItemDetailStateChange?: (
    tabId: string,
    state: EmbeddedWorkItemDetailState
  ) => void;
}

const LinearProjectsPage: React.FC<LinearProjectsPageProps> = ({
  surface = "projects",
  connectionId,
  projectId,
  projectName,
  teamId,
  teamName,
  workStationTabId,
  repoPath,
  workstationHeaderHost = "project",
  isActive = true,
  breadcrumbSegments,
  linearSurfaceControls,
  onOpenLinearProject,
  onEmbeddedWorkItemDetailStateChange,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const [collapseAllSignal, setCollapseAllSignal] = useState(0);

  const indexData = useLinearIndexData({
    connectionId,
    projectId,
    surface,
    teamId,
    isActive,
  });
  const {
    effectiveConnectionId,
    loadingConnections,
    connectionLoadError,
    indexProjects,
    indexWorkItems,
    indexLoading,
    indexLoaded,
    indexError,
    indexStatusFilter,
    setIndexStatusFilter,
    indexStatusCounts,
    indexFilteredWorkItems,
    indexGroupedWorkItems,
    linearProjectsGroupModeOptions,
    handleLinearProjectsGroupModeChange,
    linearProjectsGroupMode,
    groupedIndexProjects,
    handleIndexRefresh,
    handleUpdateIndexWorkItem,
    indexUpdateError,
  } = indexData;

  const data = useLinearProjectsData({
    connectionId: effectiveConnectionId,
    projectId,
    isActive,
  });
  const {
    project,
    teams,
    workflowStates,
    workItems,
    filteredWorkItems,
    groupedWorkItems,
    statusCounts,
    navigation,
    selectedWorkItem,
    issueStateIdsById,
    linearStatusOptions,
    linearIssueStatusConfig,
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
    issueDraft: _issueDraft,
    setSelectedIssueId,
    setActiveTab,
    setProjectDraft,
    setCreatingProject,
    handleRefresh,
    handleNavigate,
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
    setStatusFilter,
  } = data;

  const handleSelectIndexProject = useCallback(
    (selectedProjectId: string) => {
      const selectedProject = indexProjects.find(
        (linearProject) => linearProject.id === selectedProjectId
      );
      if (!selectedProject || !effectiveConnectionId) return;
      onOpenLinearProject?.({
        connectionId: effectiveConnectionId,
        projectId: selectedProject.id,
        projectName: selectedProject.name,
        teamId,
        teamName,
      });
    },
    [
      effectiveConnectionId,
      indexProjects,
      onOpenLinearProject,
      teamId,
      teamName,
    ]
  );

  const handleSelectIndexWorkItem = useCallback(
    (selectedWorkItemId: string) => {
      const selectedIndexWorkItem = indexWorkItems.find(
        (indexWorkItem) => indexWorkItem.session_id === selectedWorkItemId
      );
      const selectedProjectId = selectedIndexWorkItem?.project?.id;
      const selectedProjectName = selectedIndexWorkItem?.project?.name;
      if (
        !selectedProjectId ||
        !selectedProjectName ||
        !effectiveConnectionId
      ) {
        return;
      }
      onOpenLinearProject?.({
        connectionId: effectiveConnectionId,
        projectId: selectedProjectId,
        projectName: selectedProjectName,
        teamId,
        teamName,
      });
      setSelectedIssueId(selectedWorkItemId);
    },
    [
      effectiveConnectionId,
      indexWorkItems,
      onOpenLinearProject,
      setSelectedIssueId,
      teamId,
      teamName,
    ]
  );

  const handleCollapseAll = useCallback(() => {
    setCollapseAllSignal((currentSignal) => currentSignal + 1);
  }, []);

  const surfaceTitle =
    surface === "work-items"
      ? t("workspace.workItems")
      : t("workspace.projects");

  const linearProjectsGroupModeSelect = useMemo(
    () => (
      <Select
        value={linearProjectsGroupMode}
        onChange={handleLinearProjectsGroupModeChange}
        options={linearProjectsGroupModeOptions}
        size="small"
        appearance="ghost"
        radius="lg"
        dropdownWidthMode="auto"
        dropdownAlign="right"
        className="w-auto"
      />
    ),
    [
      handleLinearProjectsGroupModeChange,
      linearProjectsGroupMode,
      linearProjectsGroupModeOptions,
    ]
  );

  const headerLeadingControls = useMemo(
    () => linearSurfaceControls,
    [linearSurfaceControls]
  );

  const headerRefresh = projectId ? handleRefresh : handleIndexRefresh;
  const headerRefreshLoading = projectId
    ? loadingProject || loadingIssues || loadingWorkflowStates || savingIssue
    : indexLoading;

  useEffect(() => {
    if (surface === "work-items" && activeTab !== "List") {
      setActiveTab("List");
    }
  }, [activeTab, setActiveTab, surface]);

  useEffect(() => {
    if (!onEmbeddedWorkItemDetailStateChange || !workStationTabId) return;

    if (selectedWorkItem) {
      onEmbeddedWorkItemDetailStateChange(workStationTabId, {
        view: "workItemDetail",
        workItemName: selectedWorkItem.name,
      });
      return;
    }

    onEmbeddedWorkItemDetailStateChange(workStationTabId, {
      view: "project",
      parentChrome:
        surface === "work-items"
          ? getProjectLinearWorkItemsTabChrome(
              project?.name ?? projectName ?? surfaceTitle
            )
          : getProjectLinearProjectsTabChrome(
              project?.name ?? projectName ?? surfaceTitle
            ),
    });
  }, [
    onEmbeddedWorkItemDetailStateChange,
    project?.name,
    projectName,
    selectedWorkItem,
    surface,
    surfaceTitle,
    workStationTabId,
  ]);

  useProjectManagerWorkItemsTabBarRegistration({
    workStationTabId,
    enabled: isActive,
    showPropertiesActive: false,
    onSearch: null,
    onRefresh: headerRefresh,
    refreshLoading: headerRefreshLoading,
    onToggleProperties: null,
    onAddProject: null,
    onAddWorkItem: null,
  });

  const detailContent = selectedWorkItem && project && (
    <Suspense fallback={<Placeholder variant="loading" />}>
      <WorkItemDetail
        workItem={selectedWorkItem}
        onClose={() => setSelectedIssueId(null)}
        onNavigate={handleNavigate}
        hasPrev={navigation.hasPrev}
        hasNext={navigation.hasNext}
        onUpdateWorkItem={(updates) =>
          handleUpdateIssue(selectedWorkItem.session_id, updates)
        }
        onDeleteWorkItem={handleArchiveIssue}
        showTime={true}
        externalStatusConfig={linearIssueStatusConfig}
        surface={WORK_ITEM_DETAIL_SURFACE.nested}
        breadcrumbProjectName={project.name}
        propertiesOpen={true}
        publishHeaderToWorkstation={!!workStationTabId && isActive}
        workstationHeaderHost={workstationHeaderHost}
      />
    </Suspense>
  );

  const linearProjectInfoContent = project ? (
    <LinearProjectInfoPage
      project={project}
      workItems={workItems}
      saving={savingProject}
      repoPath={repoPath}
      onUpdateProject={handleUpdateProject}
    />
  ) : null;

  const linearSettingsContent = project ? (
    <LinearProjectSettings
      project={project}
      states={workflowStates}
      loadingStates={loadingWorkflowStates}
      savingStateId={savingWorkflowStateId}
      onRefreshStates={loadWorkflowStates}
      onCreateState={handleCreateWorkflowState}
      onUpdateState={handleUpdateWorkflowState}
      onArchiveState={handleArchiveWorkflowState}
    />
  ) : null;

  if (loadingConnections) {
    return (
      <Placeholder
        variant="loading"
        placement="detail-panel"
        title={t("linearProjects.loading")}
        fillParentHeight
      />
    );
  }

  if (!effectiveConnectionId) {
    return (
      <Placeholder
        variant="empty"
        placement="detail-panel"
        title={t("linearProjects.emptyConnections.title")}
        subtitle={
          connectionLoadError ??
          t("linearProjects.emptyConnections.description")
        }
        fillParentHeight
      />
    );
  }

  if (!projectId && !creatingProject) {
    if (surface === "projects") {
      return (
        <LinearProjectsIndexProjectsView
          title={surfaceTitle}
          breadcrumbSegments={breadcrumbSegments}
          collapseAllSignal={collapseAllSignal}
          groupedIndexProjects={groupedIndexProjects}
          indexLoaded={indexLoaded}
          indexLoading={indexLoading}
          indexError={indexError}
          headerLeadingControls={headerLeadingControls}
          trailingControls={linearProjectsGroupModeSelect}
          isActive={isActive}
          workstationHeaderHost={workstationHeaderHost}
          onCollapseAll={handleCollapseAll}
          onRefresh={handleIndexRefresh}
          onSelectProject={handleSelectIndexProject}
        />
      );
    }

    return (
      <LinearProjectsIndexWorkItemsView
        title={surfaceTitle}
        breadcrumbSegments={breadcrumbSegments}
        indexStatusFilter={indexStatusFilter}
        indexStatusCounts={indexStatusCounts}
        indexGroupedWorkItems={indexGroupedWorkItems}
        indexFilteredWorkItems={indexFilteredWorkItems}
        indexWorkItems={indexWorkItems}
        indexLoaded={indexLoaded}
        indexLoading={indexLoading}
        indexError={indexError}
        indexUpdateError={indexUpdateError}
        collapseAllSignal={collapseAllSignal}
        headerLeadingControls={headerLeadingControls}
        isActive={isActive}
        workstationHeaderHost={workstationHeaderHost}
        onStatusFilterChange={setIndexStatusFilter}
        onCollapseAll={handleCollapseAll}
        onRefresh={handleIndexRefresh}
        onSelectWorkItem={handleSelectIndexWorkItem}
        onUpdateWorkItem={handleUpdateIndexWorkItem}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden text-text-1">
      {!selectedWorkItem && (
        <WorkItemsPageHeader
          projectName={project?.name ?? projectName ?? surfaceTitle}
          breadcrumbSegments={breadcrumbSegments}
          activeTab={activeTab}
          statusFilter={statusFilter}
          onStatusFilterChange={(value) =>
            setStatusFilter(value as Parameters<typeof setStatusFilter>[0])
          }
          statusCounts={statusCounts}
          onCollapseAll={handleCollapseAll}
          leadingControls={headerLeadingControls}
          onRefresh={headerRefresh}
          refreshLoading={headerRefreshLoading}
          publishToWorkstationHeader={isActive}
          workstationHeaderHost={workstationHeaderHost}
        />
      )}

      {creatingProject ? (
        <LinearProjectCreateView
          projectDraft={projectDraft}
          teams={teams}
          savingProject={savingProject}
          onDraftChange={setProjectDraft}
          onSubmit={handleCreateProject}
          onCancel={() => setCreatingProject(false)}
        />
      ) : loadingProject && !project ? (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          title={t("linearProjects.loadingProjects")}
          fillParentHeight
        />
      ) : error && !project ? (
        <Placeholder
          variant="error"
          placement="detail-panel"
          title={error}
          onRetry={handleRefresh}
          fillParentHeight
        />
      ) : project ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <LinearProjectSelectedContent
            activeTab={activeTab}
            loadingIssues={loadingIssues}
            loadingWorkflowStates={loadingWorkflowStates}
            savingIssue={savingIssue}
            workItems={workItems}
            groupedWorkItems={groupedWorkItems}
            filteredWorkItems={filteredWorkItems}
            selectedWorkItem={selectedWorkItem}
            selectedIssueId={selectedIssueId}
            issueStateIdsById={issueStateIdsById}
            linearStatusOptions={linearStatusOptions}
            error={error}
            collapseAllSignal={collapseAllSignal}
            overviewContent={linearProjectInfoContent}
            settingsContent={linearSettingsContent}
            detailContent={detailContent}
            onRefresh={handleRefresh}
            onSelectWorkItem={setSelectedIssueId}
            onUpdateWorkItem={handleUpdateIssue}
            onDeleteWorkItem={handleArchiveIssue}
            onAddListItem={handleCreateIssueForStatus}
            onExternalStatusChange={handleUpdateIssueWorkflowState}
          />
        </div>
      ) : (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("linearProjects.emptySelection.title")}
          subtitle={t("linearProjects.emptySelection.description")}
          fillParentHeight
        />
      )}
    </div>
  );
};

export default LinearProjectsPage;
