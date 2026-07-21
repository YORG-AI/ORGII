import React from "react";
import { useTranslation } from "react-i18next";

import type { LinearProjectSummary } from "@src/api/http/integrations";
import type { WorkstationTabHeaderHost } from "@src/hooks/workStation";
import {
  ProjectRow,
  ProjectsPageHeader,
} from "@src/modules/ProjectManager/Projects/components";
import WorkItemSection from "@src/modules/ProjectManager/WorkItems/components/WorkItemSection";
import WorkItemsListSurface from "@src/modules/ProjectManager/WorkItems/components/WorkItemsListSurface";
import WorkItemsPageHeader from "@src/modules/ProjectManager/WorkItems/components/WorkItemsPageHeader";
import type { StatusFilterType } from "@src/modules/ProjectManager/WorkItems/types";
import {
  countWorkItemsByStatus,
  groupWorkItemsForStatusFilter,
} from "@src/modules/ProjectManager/WorkItems/workItemsViewModel";
import { getProjectStatusConfig } from "@src/modules/ProjectManager/config/manage";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import type { DropdownOption } from "@src/types/core/shared";
import type { WorkItem, WorkItemStatus } from "@src/types/core/workItem";

import { ProjectForm } from "./ProjectForm";
import type { ProjectDraft } from "./types";
import type { LinearProjectGroup } from "./useLinearIndexData";

const EMPTY_WORK_ITEM_ID_SET = new Set<string>();
const SECTION_BASE_CONFIG = getProjectStatusConfig("planned");

interface LinearProjectsIndexProjectsViewProps {
  title: string;
  breadcrumbSegments?: readonly { label: string }[];
  collapseAllSignal: number;
  groupedIndexProjects: LinearProjectGroup[];
  indexLoaded: boolean;
  indexLoading: boolean;
  indexError: string | null;
  headerLeadingControls?: React.ReactNode;
  trailingControls?: React.ReactNode;
  isActive: boolean;
  workstationHeaderHost: WorkstationTabHeaderHost;
  onCollapseAll: () => void;
  onRefresh: () => void;
  onSelectProject: (projectId: string) => void;
}

export function LinearProjectsIndexProjectsView({
  title,
  breadcrumbSegments,
  collapseAllSignal,
  groupedIndexProjects,
  indexLoaded,
  indexLoading,
  indexError,
  headerLeadingControls,
  trailingControls,
  isActive,
  workstationHeaderHost,
  onCollapseAll,
  onRefresh,
  onSelectProject,
}: LinearProjectsIndexProjectsViewProps) {
  const { t } = useTranslation(["projects", "common"]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden text-text-1">
      <ProjectsPageHeader
        title={title}
        breadcrumbSegments={breadcrumbSegments}
        onCollapseAll={onCollapseAll}
        onRefresh={onRefresh}
        refreshLoading={indexLoading}
        leadingControls={headerLeadingControls}
        trailingControls={trailingControls}
        publishToWorkstationHeader={isActive}
        workstationHeaderHost={workstationHeaderHost}
      />

      {(!indexLoaded || indexLoading) && groupedIndexProjects.length === 0 ? (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          title={t("linearProjects.loadingProjects")}
          fillParentHeight
        />
      ) : indexError ? (
        <Placeholder
          variant="error"
          placement="detail-panel"
          title={indexError}
          onRetry={onRefresh}
          fillParentHeight
        />
      ) : groupedIndexProjects.every((group) => group.projects.length === 0) ? (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("linearProjects.emptyProjects")}
          fillParentHeight
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide">
          <div className="flex flex-col pb-3">
            {groupedIndexProjects.map((group) => (
              <WorkItemSection
                key={`${group.key}:${collapseAllSignal}`}
                status={group.key}
                statusConfig={{
                  ...SECTION_BASE_CONFIG,
                  value: group.key,
                  color: group.color,
                  icon: group.icon,
                }}
                label={group.label}
                count={group.projects.length}
                defaultExpanded={collapseAllSignal === 0}
              >
                {group.projects.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    isSelected={false}
                    onSelect={onSelectProject}
                  />
                ))}
              </WorkItemSection>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface LinearProjectsIndexWorkItemsViewProps {
  title: string;
  breadcrumbSegments?: readonly { label: string }[];
  indexStatusFilter: StatusFilterType;
  indexStatusCounts: ReturnType<typeof countWorkItemsByStatus>;
  indexGroupedWorkItems: ReturnType<typeof groupWorkItemsForStatusFilter>;
  indexFilteredWorkItems: WorkItem[];
  indexWorkItems: WorkItem[];
  indexLoaded: boolean;
  indexLoading: boolean;
  indexError: string | null;
  indexUpdateError: string | null;
  collapseAllSignal: number;
  headerLeadingControls?: React.ReactNode;
  isActive: boolean;
  workstationHeaderHost: WorkstationTabHeaderHost;
  onStatusFilterChange: (filter: StatusFilterType) => void;
  onCollapseAll: () => void;
  onRefresh: () => void;
  onSelectWorkItem: (workItemId: string) => void;
  onUpdateWorkItem: (
    workItemId: string,
    updates: Partial<WorkItem>
  ) => Promise<void>;
}

export function LinearProjectsIndexWorkItemsView({
  title,
  breadcrumbSegments,
  indexStatusFilter,
  indexStatusCounts,
  indexGroupedWorkItems,
  indexFilteredWorkItems,
  indexWorkItems,
  indexLoaded,
  indexLoading,
  indexError,
  indexUpdateError,
  collapseAllSignal,
  headerLeadingControls,
  isActive,
  workstationHeaderHost,
  onStatusFilterChange,
  onCollapseAll,
  onRefresh,
  onSelectWorkItem,
  onUpdateWorkItem,
}: LinearProjectsIndexWorkItemsViewProps) {
  const { t } = useTranslation(["projects", "common"]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden text-text-1">
      <WorkItemsPageHeader
        projectName={title}
        breadcrumbSegments={breadcrumbSegments}
        activeTab="List"
        statusFilter={indexStatusFilter}
        onStatusFilterChange={(value) =>
          onStatusFilterChange(value as StatusFilterType)
        }
        statusCounts={indexStatusCounts}
        onCollapseAll={onCollapseAll}
        onRefresh={onRefresh}
        refreshLoading={indexLoading}
        leadingControls={headerLeadingControls}
        publishToWorkstationHeader={isActive}
        workstationHeaderHost={workstationHeaderHost}
      />

      <div className="min-h-0 flex-1 overflow-hidden">
        {(!indexLoaded || indexLoading) && indexWorkItems.length === 0 ? (
          <Placeholder
            variant="loading"
            placement="detail-panel"
            title={t("linearProjects.loadingIssues")}
            fillParentHeight
          />
        ) : indexError || indexUpdateError ? (
          <Placeholder
            variant="error"
            placement="detail-panel"
            title={indexError ?? indexUpdateError ?? ""}
            onRetry={onRefresh}
            fillParentHeight
          />
        ) : (
          <WorkItemsListSurface
            groupedWorkItems={indexGroupedWorkItems}
            filteredWorkItems={indexFilteredWorkItems}
            selectedWorkItem={null}
            selectedWorkItemId={null}
            workItems={indexWorkItems}
            availableMembers={[]}
            checkedWorkItemIds={EMPTY_WORK_ITEM_ID_SET}
            onSelectWorkItem={onSelectWorkItem}
            onUpdateWorkItem={onUpdateWorkItem}
            emptyListPlaceholder={
              <Placeholder
                variant="empty"
                placement="detail-panel"
                title={t("linearProjects.emptyIssues")}
                fillParentHeight
              />
            }
            statusDisabled
            collapseAllSignal={collapseAllSignal}
            hidePropertiesPanel
          />
        )}
      </div>
    </div>
  );
}

interface LinearProjectCreateViewProps {
  projectDraft: ProjectDraft;
  teams: LinearProjectSummary["teams"];
  savingProject: boolean;
  onDraftChange: (draft: ProjectDraft) => void;
  onSubmit: () => Promise<void>;
  onCancel: () => void;
}

export function LinearProjectCreateView({
  projectDraft,
  teams,
  savingProject,
  onDraftChange,
  onSubmit,
  onCancel,
}: LinearProjectCreateViewProps) {
  const { t } = useTranslation(["projects", "common"]);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-5 scrollbar-hide">
      <section className="mx-auto max-w-3xl rounded-lg border border-border-1 bg-fill-1 p-5">
        <h2 className="text-base font-semibold">
          {t("linearProjects.forms.createProjectTitle")}
        </h2>
        <ProjectForm
          draft={projectDraft}
          teams={teams}
          saving={savingProject}
          submitLabel={t("linearProjects.createProject")}
          onDraftChange={onDraftChange}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </section>
    </main>
  );
}

interface LinearProjectSelectedContentProps {
  activeTab: string;
  loadingIssues: boolean;
  loadingWorkflowStates: boolean;
  savingIssue: boolean;
  workItems: WorkItem[];
  groupedWorkItems: ReturnType<typeof groupWorkItemsForStatusFilter>;
  filteredWorkItems: WorkItem[];
  selectedWorkItem: WorkItem | null;
  selectedIssueId: string | null;
  issueStateIdsById: Map<string, string>;
  linearStatusOptions: DropdownOption<string>[];
  error: string | null;
  collapseAllSignal: number;
  overviewContent: React.ReactNode;
  settingsContent: React.ReactNode;
  detailContent: React.ReactNode;
  onRefresh: () => void;
  onSelectWorkItem: (id: string | null) => void;
  onUpdateWorkItem: (
    workItemId: string,
    updates: Partial<WorkItem>
  ) => Promise<void>;
  onDeleteWorkItem: (workItemId: string) => Promise<void>;
  onAddListItem: (status: WorkItemStatus) => Promise<void>;
  onExternalStatusChange: (
    workItemId: string,
    stateId: string
  ) => Promise<void>;
}

export function LinearProjectSelectedContent({
  activeTab,
  loadingIssues,
  loadingWorkflowStates,
  savingIssue,
  workItems,
  groupedWorkItems,
  filteredWorkItems,
  selectedWorkItem,
  selectedIssueId,
  issueStateIdsById,
  linearStatusOptions,
  error,
  collapseAllSignal,
  overviewContent,
  settingsContent,
  detailContent,
  onRefresh,
  onSelectWorkItem,
  onUpdateWorkItem,
  onDeleteWorkItem,
  onAddListItem,
  onExternalStatusChange,
}: LinearProjectSelectedContentProps) {
  const { t } = useTranslation(["projects", "common"]);

  if (activeTab === "Overview") return overviewContent;
  if (activeTab === "Settings") return settingsContent;

  if (loadingIssues && workItems.length === 0) {
    return (
      <Placeholder
        variant="loading"
        placement="detail-panel"
        title={t("linearProjects.loadingIssues")}
        fillParentHeight
      />
    );
  }

  if (error && workItems.length === 0) {
    return (
      <Placeholder
        variant="error"
        placement="detail-panel"
        title={error}
        onRetry={onRefresh}
        fillParentHeight
      />
    );
  }

  return (
    <WorkItemsListSurface
      groupedWorkItems={groupedWorkItems}
      filteredWorkItems={filteredWorkItems}
      selectedWorkItem={selectedWorkItem}
      selectedWorkItemId={selectedIssueId}
      workItems={workItems}
      availableMembers={[]}
      checkedWorkItemIds={EMPTY_WORK_ITEM_ID_SET}
      onSelectWorkItem={onSelectWorkItem}
      onUpdateWorkItem={onUpdateWorkItem}
      onDeleteWorkItem={onDeleteWorkItem}
      onAddListItem={onAddListItem}
      externalStatusOptions={linearStatusOptions}
      getExternalStatusValue={(workItem) =>
        issueStateIdsById.get(workItem.session_id)
      }
      onExternalStatusChange={onExternalStatusChange}
      statusDisabled={loadingWorkflowStates || savingIssue}
      collapseAllSignal={collapseAllSignal}
      detailContent={detailContent}
      emptyListPlaceholder={
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("linearProjects.emptyIssues")}
          fillParentHeight
        />
      }
    />
  );
}
