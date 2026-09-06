import { useAtomValue, useSetAtom } from "jotai";
import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { STORY_SYNC_ADAPTER } from "@src/api/http/integrations/syncConnections";
import type { SavedView, SavedViewDisplay } from "@src/api/http/project";
import { projectSyncApi } from "@src/api/http/project/sync";
import { Placeholder } from "@src/components/Placeholder";
import Select from "@src/components/Select";
import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { useProjectOrgCloudPermissions } from "@src/features/Org2Cloud/useProjectOrgCloudPermissions";
import { useCurrentUserMemberIds } from "@src/hooks/project/useCurrentUserMemberId";
import type { WorkstationTabHeaderHost } from "@src/hooks/tabHost/useWorkstationTabHeader";
import { DeliveryBox01Icon, HugeiconsIcon } from "@src/icons";
import type { LinkedRepoOption } from "@src/modules/ProjectManager/shared";
import type { ProjectManagerBreadcrumbSegment } from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import { WorkManagementSearchInput } from "@src/modules/shared/components/WorkManagementSearchInput";
import SplitListFullscreenButton from "@src/modules/shared/layouts/SplitListFullscreenButton";
import { reposAtom } from "@src/store/repo";
import { syncDeepLinkAtom } from "@src/store/sync";
import { userAtom } from "@src/store/user/userAtom";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import {
  PROJECT_DETAIL_SURFACE_VIEW,
  type ProjectDetailSurfaceView,
} from "@src/store/workstation/tabs";
import type { WorkItemStatus } from "@src/types/core/workItem";
import type { WorkItem } from "@src/types/core/workItem";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import { ProjectDetailSurfacePillSwitch } from "../ProjectManagerLayout/components/ProjectDetailSurfacePillSwitch";
import {
  EmbeddedWorkItemDetail,
  MultiSelectBar,
  OverviewPropertiesPanel,
  WorkItemsPageHeader,
  WorkItemsTabContent,
} from "./components";
import BatchPropertyDialog from "./components/BatchPropertyDialog";
import BatchQuickFieldDialog from "./components/BatchQuickFieldDialog";
import PropertyFilterControl from "./components/PropertyFilterControl";
import RevisionConflictModal from "./components/RevisionConflictModal";
import SavedViewsControl from "./components/SavedViewsControl";
import type { WorkItemsTableSort } from "./components/WorkItemsTableView";
import { getEffectiveWorkItemPrefix } from "./config";
import { useBufferedProjectProperties } from "./hooks/useBufferedProjectProperties";
import { useMultiSelect } from "./hooks/useMultiSelect";
import { useEnsureStatusDefinitions } from "./hooks/useStatusDefinitions";
import { useWorkItemPropertyView } from "./hooks/useWorkItemPropertyView";
import { useWorkItems } from "./hooks/useWorkItems";
import { useWorkItemsHeaderState } from "./hooks/useWorkItemsHeaderState";
import { useWorkItemsSync } from "./hooks/useWorkItemsSync";
import {
  type EmbeddedWorkItemDetailState,
  useWorkItemsTabBarState,
} from "./hooks/useWorkItemsTabBarState";
import {
  type WorkItemPropertyFilter,
  filterWorkItemsByProperty,
  indexScopePropertyValues,
} from "./propertyViewModel";
import {
  type StatusFilterType,
  WORK_ITEMS_DEFAULT_STATUS,
  type WorkItemsViewTab,
} from "./types";
import type { BatchQuickField } from "./workItemPartialUpdate";
import {
  WORK_ITEMS_KANBAN_GROUP,
  type WorkItemsKanbanGroup,
  getStatusFilterKeysForWorkItems,
} from "./workItemsViewModel";

const WorkItemsSettings = React.lazy(
  () => import("./components/WorkItemsSettings")
);

const WORK_ITEMS_VIEW_TABS: readonly WorkItemsViewTab[] = [
  "List",
  "Table",
  "Kanban",
  "Gantt",
  "Calendar",
];

// ============================================
// Types
// ============================================

export type { EmbeddedWorkItemDetailState } from "./hooks/useWorkItemsTabBarState";

interface WorkItemsPageProps {
  breadcrumbSegments?: readonly ProjectManagerBreadcrumbSegment[];
  /** Project ID from the active tab */
  projectId: string;
  /** Project name from the active tab (for display) */
  projectName: string;
  /** Display title override for aggregate Work Items surfaces. */
  pageTitle?: string;
  /** Cached project slug from tab data — enables parallel work item loading */
  cachedProjectSlug?: string;
  /** Workspace path used by editor context menus. */
  repoPath?: string | null;
  /** Surface to show for the project detail tab. */
  projectView?: ProjectDetailSurfaceView;
  /** Persist project detail surface changes to the owning tab. */
  onProjectViewChange?: (view: ProjectDetailSurfaceView) => void;
  /** Called when the resolved project slug is known, so the layout can persist it to the tab */
  onProjectSlugResolved?: (slug: string) => void;
  /** Navigate back to the Projects index from the breadcrumb. */
  onOpenProjects?: () => void;
  /** Callback to open the "New Project" modal */
  onCreateProject?: () => void;
  /** Callback to open a "New Work Item" tab */
  onCreateWorkItem?: (
    projectId: string,
    projectName: string,
    projectSlug: string
  ) => void;
  /** Callback after project is deleted (e.g. close the tab) */
  onProjectDeleted?: () => void;
  /** Notify parent tab system about unsaved changes (for dot indicator) */
  onSetUnsaved?: (unsaved: boolean) => void;
  /** Notify parent tab system when the project title changes */
  onProjectNameUpdated?: (projectName: string) => void;
  /** Navigate to repo-level settings (Projects > Settings tab) */
  onOpenRepoSettings?: () => void;
  /** Open a work item in its own dedicated tab (carries unsaved changes) */
  onExpandWorkItemToTab?: (
    workItemId: string,
    workItemName: string,
    pendingUpdates?: Record<string, unknown>,
    workItemStatus?: string,
    workItem?: WorkItem
  ) => void;
  /** Open an agent session in a chat tab */
  onOpenChatSession?: (sessionId: string, title?: string) => void;
  /** Report whether this project tab is showing its list or an embedded work item detail. */
  onEmbeddedWorkItemDetailStateChange?: (
    tabId: string,
    state: EmbeddedWorkItemDetailState
  ) => void;
  /** Whether this tab is the currently visible tab (gates background refreshes) */
  isActive?: boolean;
  /**
   * When set (Workstation Project Manager), Info / Add work item are shown on
   * the Workstation tab bar instead of the page header.
   */
  workStationTabId?: string;
  /** Target workstation host slot for the published 36px header. */
  workstationHeaderHost?: WorkstationTabHeaderHost;
  /** Parent-owned context control shown before split-list header content. */
  splitHeaderLeading?: React.ReactNode;
}

// ============================================
// Main Component
// ============================================

const WorkItemsPage: React.FC<WorkItemsPageProps> = ({
  breadcrumbSegments,
  projectId,
  projectName: tabProjectName,
  pageTitle,
  cachedProjectSlug,
  repoPath,
  projectView = PROJECT_DETAIL_SURFACE_VIEW.WORK_ITEMS,
  onProjectViewChange,
  onProjectSlugResolved,
  onOpenProjects,
  onCreateProject,
  onCreateWorkItem,
  onProjectDeleted,
  onSetUnsaved,
  onProjectNameUpdated,
  onOpenRepoSettings,
  onExpandWorkItemToTab,
  onOpenChatSession,
  onEmbeddedWorkItemDetailStateChange,
  isActive = true,
  workStationTabId,
  workstationHeaderHost = "project",
  splitHeaderLeading,
}) => {
  const { t } = useTranslation("projects");
  const interactiveBreadcrumbSegments = useMemo(
    () =>
      breadcrumbSegments?.map((segment, index) =>
        index === 0 && onOpenProjects && !segment.onClick
          ? { ...segment, onClick: onOpenProjects }
          : segment
      ),
    [breadcrumbSegments, onOpenProjects]
  );
  const { canAdminister: canAdministerProjectOrg } =
    useProjectOrgCloudPermissions(isActive);
  const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);
  const currentUser = useAtomValue(userAtom);
  const savedViewPreferenceOwnerId =
    currentUser.uuid?.trim() || currentUser.authing_id?.trim() || "local";
  const allRepos = useAtomValue(reposAtom);
  const availableRepos = useMemo<LinkedRepoOption[]>(
    () =>
      allRepos
        .map((repo) => ({
          id: repo.path ?? repo.fs_uri ?? repo.id,
          name: repo.name || repo.path || repo.id,
        }))
        .filter((repo) => repo.id),
    [allRepos]
  );
  const deepLinkRequest = useAtomValue(syncDeepLinkAtom);
  const setDeepLinkRequest = useSetAtom(syncDeepLinkAtom);
  const { state, data, projectData, handlers } = useWorkItems({
    projectId,
    cachedProjectSlug,
    initialActiveTab:
      projectView === PROJECT_DETAIL_SURFACE_VIEW.OVERVIEW
        ? "Overview"
        : "List",
    isActive,
  });
  const { handleTabChange } = handlers;
  const { memberIds: currentUserMemberIds } = useCurrentUserMemberIds(
    projectData.rawMembers
  );
  const pinnedKanbanColumnIds = useMemo(
    () => [...currentUserMemberIds].map((memberId) => `person:${memberId}`),
    [currentUserMemberIds]
  );
  const statusFilterKeys = useMemo(
    () => getStatusFilterKeysForWorkItems(data.workItems),
    [data.workItems]
  );
  const { statusFilter, setStatusFilter } = state;
  useEffect(() => {
    if (!statusFilterKeys.includes(statusFilter)) {
      setStatusFilter("all");
    }
  }, [setStatusFilter, statusFilter, statusFilterKeys]);

  // Persist resolved slug to tab data for faster loading on next app launch
  const resolvedSlug = projectData.project?.slug;
  const reportedSlugRef = useRef<string | null>(null);
  useEffect(() => {
    if (resolvedSlug && resolvedSlug !== reportedSlugRef.current) {
      reportedSlugRef.current = resolvedSlug;
      onProjectSlugResolved?.(resolvedSlug);
    }
  }, [resolvedSlug, onProjectSlugResolved]);
  const [collapseAllSignal, setCollapseAllSignal] = useState(0);
  const [listFullscreen, setListFullscreen] = useState(false);
  const [kanbanGroupBy, setKanbanGroupBy] = useState<WorkItemsKanbanGroup>(
    WORK_ITEMS_KANBAN_GROUP.STATUS
  );
  const handleWorkItemsTabChange = useCallback(
    (tab: WorkItemsViewTab) => {
      if (tab !== "List" || state.activeTab !== "List") {
        setListFullscreen(false);
      }
      handleTabChange(tab);
    },
    [handleTabChange, state.activeTab]
  );

  // Deep-link consumer (Phase 4.8 Track D) — keep the request available until
  // the Settings view has rendered it once. Clearing it in the same effect as
  // the tab switch would remove the request before WorkItemsSettings mounts.
  const settingsSectionRequest =
    deepLinkRequest && resolvedSlug && deepLinkRequest.slug === resolvedSlug
      ? deepLinkRequest
      : undefined;
  useEffect(() => {
    if (!settingsSectionRequest) return;
    if (state.activeTab !== "Settings") {
      handleTabChange("Settings");
      return;
    }
    setDeepLinkRequest(null);
  }, [
    handleTabChange,
    setDeepLinkRequest,
    settingsSectionRequest,
    state.activeTab,
  ]);

  const confirmWorkItemDelete = useCallback(
    async (name?: string) =>
      confirmDestructiveAction({
        title: name
          ? t("common:actions.confirmDeleteTitle", { name })
          : t("common:actions.confirmDelete"),
        message: t("common:actions.confirmDeleteMessage"),
        okLabel: t("common:actions.delete"),
        cancelLabel: t("common:actions.cancel"),
      }),
    [t]
  );
  const handleDeleteWorkItem = useCallback(
    async (workItemId: string) => {
      const item = data.workItems.find(
        (candidate) => candidate.session_id === workItemId
      );
      if (!(await confirmWorkItemDelete(item?.name))) return;
      await handlers.handleDelete(workItemId);
    },
    [confirmWorkItemDelete, data.workItems, handlers]
  );

  const propertyOrgId = projectData.project?.orgId ?? "personal-org";
  const propertyProjectSlug =
    projectData.project?.slug ?? cachedProjectSlug ?? null;
  const propertyScopeKey = JSON.stringify([propertyOrgId, propertyProjectSlug]);
  const [propertyViewSettings, setPropertyViewSettings] = useState<{
    scopeKey: string;
    selectedPropertyId: string | null;
    filter: WorkItemPropertyFilter | null;
    groupBy: string | null;
  }>(() => ({
    scopeKey: propertyScopeKey,
    selectedPropertyId: null,
    filter: null,
    groupBy: null,
  }));
  const propertySettingsMatchScope =
    propertyViewSettings.scopeKey === propertyScopeKey;
  const propertyFilterPropertyId = propertySettingsMatchScope
    ? propertyViewSettings.selectedPropertyId
    : null;
  const propertyFilter = propertySettingsMatchScope
    ? propertyViewSettings.filter
    : null;
  const propertyGroupBy = propertySettingsMatchScope
    ? propertyViewSettings.groupBy
    : null;
  const handlePropertyFilterPropertyChange = useCallback(
    (selectedPropertyId: string | null) => {
      setPropertyViewSettings((current) => {
        const currentFilter =
          current.scopeKey === propertyScopeKey ? current.filter : null;
        return {
          scopeKey: propertyScopeKey,
          selectedPropertyId,
          filter:
            currentFilter?.propertyId === selectedPropertyId
              ? currentFilter
              : null,
          groupBy:
            current.scopeKey === propertyScopeKey ? current.groupBy : null,
        };
      });
    },
    [propertyScopeKey]
  );
  const handlePropertyFilterChange = useCallback(
    (filter: WorkItemPropertyFilter | null) => {
      setPropertyViewSettings((current) => ({
        scopeKey: propertyScopeKey,
        selectedPropertyId:
          filter?.propertyId ??
          (current.scopeKey === propertyScopeKey
            ? current.selectedPropertyId
            : null),
        filter,
        groupBy: current.scopeKey === propertyScopeKey ? current.groupBy : null,
      }));
    },
    [propertyScopeKey]
  );
  const handlePropertyGroupByChange = useCallback(
    (groupBy: string | null) => {
      setPropertyViewSettings((current) => ({
        scopeKey: propertyScopeKey,
        selectedPropertyId:
          current.scopeKey === propertyScopeKey
            ? current.selectedPropertyId
            : null,
        filter: current.scopeKey === propertyScopeKey ? current.filter : null,
        groupBy,
      }));
    },
    [propertyScopeKey]
  );
  const propertyView = useWorkItemPropertyView({
    orgId: propertyOrgId,
    projectSlug: propertyProjectSlug,
    isActive,
  });
  const availablePropertyIds = useMemo(
    () => new Set(propertyView.definitions.map((definition) => definition.id)),
    [propertyView.definitions]
  );
  const applicablePropertyFilter =
    propertyView.ready &&
    propertyFilter &&
    availablePropertyIds.has(propertyFilter.propertyId)
      ? propertyFilter
      : null;
  const applicablePropertyGroupBy =
    propertyView.ready &&
    propertyGroupBy &&
    availablePropertyIds.has(propertyGroupBy)
      ? propertyGroupBy
      : null;
  const propertyValuesByItem = useMemo(
    () => indexScopePropertyValues(propertyView.values),
    [propertyView.values]
  );
  const propertyFilteredWorkItems = useMemo(
    () =>
      filterWorkItemsByProperty(
        data.filteredWorkItems,
        applicablePropertyFilter,
        propertyValuesByItem
      ),
    [applicablePropertyFilter, data.filteredWorkItems, propertyValuesByItem]
  );
  const propertyFilteredIds = useMemo(
    () => new Set(propertyFilteredWorkItems.map((item) => item.session_id)),
    [propertyFilteredWorkItems]
  );
  const propertyGroupedWorkItems = useMemo(
    () =>
      data.groupedWorkItems.map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          propertyFilteredIds.has(item.session_id)
        ),
      })),
    [data.groupedWorkItems, propertyFilteredIds]
  );
  const propertyKanbanTasks = useMemo(
    () => data.kanbanTasks.filter((task) => propertyFilteredIds.has(task.id)),
    [data.kanbanTasks, propertyFilteredIds]
  );
  const propertyGanttTasks = useMemo(
    () => data.ganttTasks.filter((task) => propertyFilteredIds.has(task.id)),
    [data.ganttTasks, propertyFilteredIds]
  );
  const propertyCalendarEvents = useMemo(
    () =>
      data.calendarEvents.filter((event) => propertyFilteredIds.has(event.id)),
    [data.calendarEvents, propertyFilteredIds]
  );
  const handleOpenWorkItem = useCallback(
    (workItemId: string) => {
      // A selection from the full-width List view must reveal its detail.
      setListFullscreen(false);
      handlers.handleSelect(workItemId);
    },
    [handlers]
  );

  const {
    selectedIds,
    bulkDeleting,
    handleCheckedChange,
    handleSelectAll,
    handleUnselectAll,
    handleBulkDelete,
  } = useMultiSelect({
    filteredWorkItems: propertyFilteredWorkItems,
    onDelete: handlers.handleDelete,
    projectSlug: projectData.project?.slug,
    getShortId: data.getShortId,
    onBatchDeleteComplete: data.refresh,
    onBeforeDelete: () => confirmWorkItemDelete(),
  });

  const selectedShortIds = useMemo(
    () =>
      Array.from(selectedIds)
        .map((id) => data.getShortId(id))
        .filter((shortId): shortId is string => Boolean(shortId)),
    [data, selectedIds]
  );
  const handleCollapseAll = useCallback(() => {
    setCollapseAllSignal((currentSignal) => currentSignal + 1);
  }, []);

  const { projectName, headerTitle, sourceProject } = useWorkItemsHeaderState({
    pageTitle,
    tabProjectName,
    project: projectData.project,
    projectLoading: projectData.loading,
  });

  const { handleDeleteProject } = useWorkItemsSync({
    project: projectData.project,
    projectName,
    rawMembers: projectData.rawMembers,
    workItemCount: data.workItems.length,
    onProjectDeleted,
  });

  // Track work item detail pending changes
  const [hasWorkItemPendingChanges, setHasWorkItemPendingChanges] =
    useState(false);
  const [workItemPropertiesOpen, setWorkItemPropertiesOpen] = useState(true);
  const [projectSyncAdapter, setProjectSyncAdapter] = useState<{
    projectSlug: string;
    adapterId: string | null;
  } | null>(null);

  const handleCloseDetail = useCallback(() => {
    handlers.handleCloseWorkItemDetail();
    setHasWorkItemPendingChanges(false);
  }, [handlers]);

  const linkedRepoPath = sourceProject?.linkedRepos?.[0]?.id;
  const resolvedRepoPath = linkedRepoPath ?? activeWorkspaceRootPath ?? null;
  const resolvedProjectSlug = projectData.project?.slug ?? null;
  const projectSyncAdapterId =
    projectSyncAdapter && projectSyncAdapter.projectSlug === resolvedProjectSlug
      ? projectSyncAdapter.adapterId
      : undefined;
  const projectIdentityIcon = useMemo(
    () => (
      <HugeiconsIcon
        icon={DeliveryBox01Icon}
        data-icon="box"
        size={HEADER_ICON_SIZE.sm}
        strokeWidth={1.75}
      />
    ),
    []
  );
  const selectedShortId = data.selectedWorkItem
    ? (data.getShortId(data.selectedWorkItem.session_id) ?? null)
    : null;

  useEffect(() => {
    if (!resolvedProjectSlug) return;

    let cancelled = false;
    void projectSyncApi
      .status(resolvedProjectSlug)
      .then((status) => {
        if (!cancelled) {
          setProjectSyncAdapter({
            projectSlug: resolvedProjectSlug,
            adapterId: status.adapter_id,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectSyncAdapter({
            projectSlug: resolvedProjectSlug,
            adapterId: null,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [resolvedProjectSlug]);

  const {
    actionsInStationTabBar: tabBarActionsInStationTabBar,
    propertiesActionAvailable,
  } = useWorkItemsTabBarState({
    activeTab: state.activeTab,
    showProperties: state.showProperties,
    isActive,
    workStationTabId,
    projectId,
    projectName,
    resolvedProjectSlug,
    selectedWorkItem: data.selectedWorkItem,
    onToggleProperties: handlers.handleToggleProperties,
    onCreateWorkItem,
    onAddListItem: handlers.handleAddListItem,
    onEmbeddedWorkItemDetailStateChange,
  });
  const useSplitListHeader =
    isActive && state.activeTab === "List" && !listFullscreen;

  const handleOpenSelectedWorkItemInNewTab = useCallback(() => {
    const workItem = data.selectedWorkItem;
    if (!workItem || !onExpandWorkItemToTab) return;
    onExpandWorkItemToTab(
      workItem.session_id,
      workItem.name || t("common:placeholders.untitled"),
      undefined,
      workItem.workItemStatus ?? workItem.status,
      workItem
    );
  }, [data.selectedWorkItem, onExpandWorkItemToTab, t]);

  const detailContent = (
    <EmbeddedWorkItemDetail
      workItem={data.selectedWorkItem ?? null}
      onClose={handleCloseDetail}
      onOpenInNewTab={
        onExpandWorkItemToTab ? handleOpenSelectedWorkItemInNewTab : undefined
      }
      onNavigate={handlers.handleNavigate}
      hasPrev={data.navigation.hasPrev}
      hasNext={data.navigation.hasNext}
      onUpdateWorkItem={handlers.handleUpdate}
      onDeleteWorkItem={handleDeleteWorkItem}
      availableMembers={projectData.availableMembers}
      availableProjects={projectData.availableProjects}
      availableMilestones={projectData.availableMilestones}
      availableLabels={projectData.availableLabels}
      onPendingChangesChange={setHasWorkItemPendingChanges}
      repoPath={resolvedRepoPath}
      projectSlug={resolvedProjectSlug}
      orgId={propertyOrgId}
      shortId={selectedShortId}
      onRefreshWorkItem={data.refresh}
      onOpenSession={onOpenChatSession}
      breadcrumbSegments={interactiveBreadcrumbSegments}
      breadcrumbProjectName={headerTitle}
      breadcrumbIcon={projectIdentityIcon}
      titleEditable={
        projectSyncAdapterId !== undefined &&
        projectSyncAdapterId !== STORY_SYNC_ADAPTER.GITHUB
      }
      propertiesOpen={workItemPropertiesOpen}
      onToggleProperties={() => setWorkItemPropertiesOpen((prev) => !prev)}
      publishHeaderToWorkstation={false}
      workstationHeaderHost={workstationHeaderHost}
    />
  );

  const {
    displayProject,
    handleLocalProjectUpdate,
    handleUpdateProjectMembers,
    handleProjectNameChange,
    handleProjectDescriptionChange,
    handleWorkItemPrefixUpdate,
  } = useBufferedProjectProperties({
    projectId,
    sourceProject,
    onProjectUpdate: handlers.handleProjectUpdate,
    hasWorkItemPendingChanges,
    onSetUnsaved,
    onProjectNameUpdated,
  });

  useEnsureStatusDefinitions(displayProject.orgId ?? "personal-org");

  const [tableColumns, setTableColumns] = useState<string[] | null>(null);
  const [tableSort, setTableSort] = useState<WorkItemsTableSort | null>(null);
  const [batchPropertyOpen, setBatchPropertyOpen] = useState(false);
  const [batchQuickField, setBatchQuickField] =
    useState<BatchQuickField | null>(null);

  const overviewPropertiesPanel = (
    <OverviewPropertiesPanel
      project={displayProject}
      onUpdate={handleLocalProjectUpdate}
      availableMembers={projectData.availableMembers}
      availableTeams={projectData.availableTeams}
      availableLabels={projectData.availableLabels}
      availableRepos={availableRepos}
    />
  );

  const propertiesPanel = state.showProperties && overviewPropertiesPanel;

  const activeProjectView =
    state.activeTab === "Overview"
      ? PROJECT_DETAIL_SURFACE_VIEW.OVERVIEW
      : PROJECT_DETAIL_SURFACE_VIEW.WORK_ITEMS;
  const isWorkItemsSurface =
    activeProjectView === PROJECT_DETAIL_SURFACE_VIEW.WORK_ITEMS;

  const handleProjectViewChange = useCallback(
    (nextProjectView: ProjectDetailSurfaceView) => {
      onProjectViewChange?.(nextProjectView);
      handleWorkItemsTabChange(
        nextProjectView === PROJECT_DETAIL_SURFACE_VIEW.OVERVIEW
          ? "Overview"
          : "List"
      );
    },
    [handleWorkItemsTabChange, onProjectViewChange]
  );

  const handleHeaderTabChange = useCallback(
    (nextTab: WorkItemsViewTab) => {
      onProjectViewChange?.(
        nextTab === "Overview"
          ? PROJECT_DETAIL_SURFACE_VIEW.OVERVIEW
          : PROJECT_DETAIL_SURFACE_VIEW.WORK_ITEMS
      );
      handleWorkItemsTabChange(nextTab);
    },
    [handleWorkItemsTabChange, onProjectViewChange]
  );

  const workItemsViewTabs = useMemo<TabPillItem[]>(
    () =>
      WORK_ITEMS_VIEW_TABS.map((tab) => ({
        key: tab,
        label: t(`workItems.tabs.${tab.toLowerCase()}`),
        dataTestId: `work-items-view-tab-${tab.toLowerCase()}`,
      })),
    [t]
  );
  const kanbanGroupTabs = useMemo<TabPillItem[]>(
    () => [
      {
        key: WORK_ITEMS_KANBAN_GROUP.STATUS,
        label: t("projects.groupBy.status"),
      },
      {
        key: WORK_ITEMS_KANBAN_GROUP.ASSIGNED_TO,
        label: t("projects.groupBy.assignedTo"),
      },
      {
        key: WORK_ITEMS_KANBAN_GROUP.CREATED_BY,
        label: t("projects.groupBy.createdBy"),
      },
      {
        key: WORK_ITEMS_KANBAN_GROUP.PROJECT,
        label: t("projects.groupBy.project"),
      },
      {
        key: WORK_ITEMS_KANBAN_GROUP.PROPERTY,
        label: t("projects.groupBy.property"),
      },
    ],
    [t]
  );

  const handleApplySavedView = useCallback(
    (view: SavedView, display: SavedViewDisplay) => {
      const query = view.query ?? {};
      if (typeof query.statusFilter === "string") {
        state.setStatusFilter(query.statusFilter as StatusFilterType);
      }
      state.setSearchQuery(
        typeof query.searchQuery === "string" ? query.searchQuery : ""
      );
      const nextPropertyFilter = query.propertyFilter;
      const validPropertyFilter =
        nextPropertyFilter &&
        typeof nextPropertyFilter.propertyId === "string" &&
        typeof nextPropertyFilter.valueToken === "string"
          ? nextPropertyFilter
          : null;
      setPropertyViewSettings({
        scopeKey: propertyScopeKey,
        selectedPropertyId: validPropertyFilter?.propertyId ?? null,
        filter: validPropertyFilter,
        groupBy:
          typeof display.propertyGroupBy === "string"
            ? display.propertyGroupBy
            : null,
      });
      handleHeaderTabChange(
        typeof display.viewTab === "string" &&
          (WORK_ITEMS_VIEW_TABS as readonly string[]).includes(display.viewTab)
          ? (display.viewTab as WorkItemsViewTab)
          : "List"
      );
      setKanbanGroupBy(
        typeof display.kanbanGroupBy === "string"
          ? (display.kanbanGroupBy as WorkItemsKanbanGroup)
          : WORK_ITEMS_KANBAN_GROUP.STATUS
      );
      setTableColumns(
        Array.isArray(display.tableColumns) ? display.tableColumns : null
      );
      setTableSort(
        typeof display.sortBy === "string" &&
          (display.sortDirection === "asc" || display.sortDirection === "desc")
          ? {
              sortBy: display.sortBy,
              sortDirection: display.sortDirection,
            }
          : null
      );
    },
    [handleHeaderTabChange, propertyScopeKey, state]
  );

  const savedViewsControl = useMemo(
    () =>
      isWorkItemsSurface ? (
        <SavedViewsControl
          orgId={displayProject.orgId ?? "personal-org"}
          projectSlug={resolvedProjectSlug ?? null}
          preferenceOwnerId={savedViewPreferenceOwnerId}
          currentQuery={{
            statusFilter: state.statusFilter,
            searchQuery: state.searchQuery,
            propertyFilter: applicablePropertyFilter ?? undefined,
          }}
          currentDisplay={{
            viewTab: state.activeTab,
            kanbanGroupBy,
            tableColumns: tableColumns ?? undefined,
            propertyGroupBy: applicablePropertyGroupBy ?? undefined,
            sortBy: tableSort?.sortBy,
            sortDirection: tableSort?.sortDirection,
          }}
          onApply={handleApplySavedView}
        />
      ) : null,
    [
      displayProject.orgId,
      handleApplySavedView,
      isWorkItemsSurface,
      kanbanGroupBy,
      applicablePropertyFilter,
      applicablePropertyGroupBy,
      resolvedProjectSlug,
      savedViewPreferenceOwnerId,
      state.activeTab,
      state.searchQuery,
      state.statusFilter,
      tableColumns,
      tableSort,
    ]
  );

  const projectSurfaceControls = useMemo(
    () => (
      <div className="flex min-w-0 items-center gap-1.5">
        <ProjectDetailSurfacePillSwitch
          projectView={activeProjectView}
          onProjectViewChange={handleProjectViewChange}
        />
        {isWorkItemsSurface && (
          <>
            <span className="text-xs text-text-4">/</span>
            <TabPill
              tabs={workItemsViewTabs}
              activeTab={state.activeTab}
              onChange={(key) => handleHeaderTabChange(key as WorkItemsViewTab)}
              variant="pill"
              color="fill"
              fillWidth={false}
              size="small"
            />
            {state.activeTab === "Kanban" && (
              <>
                <span className="text-xs text-text-4">/</span>
                <TabPill
                  tabs={kanbanGroupTabs}
                  activeTab={kanbanGroupBy}
                  onChange={(key) =>
                    setKanbanGroupBy(key as WorkItemsKanbanGroup)
                  }
                  variant="pill"
                  color="fill"
                  fillWidth={false}
                  size="small"
                />
                {kanbanGroupBy === WORK_ITEMS_KANBAN_GROUP.PROPERTY && (
                  <Select
                    value={applicablePropertyGroupBy ?? undefined}
                    options={propertyView.definitions.map((definition) => ({
                      value: definition.id,
                      label: definition.name,
                    }))}
                    onChange={(value) =>
                      handlePropertyGroupByChange(String(value))
                    }
                    onClear={() => handlePropertyGroupByChange(null)}
                    allowClear
                    showSearch
                    appearance="ghost"
                    size="small"
                    placeholder={t("workItems.table.groupByProperty", {
                      defaultValue: "Group by property",
                    })}
                    ariaLabel={t("workItems.table.groupByProperty", {
                      defaultValue: "Group by property",
                    })}
                    dataTestId="work-items-kanban-property-group"
                  />
                )}
              </>
            )}
            {savedViewsControl}
            <PropertyFilterControl
              definitions={propertyView.definitions}
              values={propertyView.values}
              members={projectData.availableMembers}
              selectedPropertyId={
                propertyView.ready &&
                propertyFilterPropertyId &&
                availablePropertyIds.has(propertyFilterPropertyId)
                  ? propertyFilterPropertyId
                  : null
              }
              filter={applicablePropertyFilter}
              onSelectedPropertyIdChange={handlePropertyFilterPropertyChange}
              onFilterChange={handlePropertyFilterChange}
            />
          </>
        )}
      </div>
    ),
    [
      activeProjectView,
      handleHeaderTabChange,
      handleProjectViewChange,
      isWorkItemsSurface,
      kanbanGroupBy,
      kanbanGroupTabs,
      projectData.availableMembers,
      applicablePropertyFilter,
      applicablePropertyGroupBy,
      availablePropertyIds,
      handlePropertyFilterChange,
      handlePropertyFilterPropertyChange,
      handlePropertyGroupByChange,
      propertyFilterPropertyId,
      propertyView.definitions,
      propertyView.ready,
      propertyView.values,
      savedViewsControl,
      state.activeTab,
      t,
      workItemsViewTabs,
    ]
  );
  const workItemsSearchControl = useMemo(
    () =>
      isWorkItemsSurface && state.activeTab !== "Settings" ? (
        <div
          className={`flex min-w-0 items-center gap-1 ${
            useSplitListHeader ? "flex-1" : ""
          }`.trim()}
        >
          <WorkManagementSearchInput
            value={state.searchQuery}
            onChange={state.setSearchQuery}
            fillWidth={useSplitListHeader}
            dataTestId="project-work-items-search"
          />
        </div>
      ) : null,
    [
      isWorkItemsSurface,
      state.activeTab,
      state.searchQuery,
      state.setSearchQuery,
      useSplitListHeader,
    ]
  );
  const workItemsEndControl = useMemo(
    () =>
      isWorkItemsSurface && state.activeTab === "List" ? (
        <SplitListFullscreenButton
          isFullscreen={listFullscreen}
          onToggle={() => setListFullscreen((current) => !current)}
        />
      ) : null,
    [isWorkItemsSurface, listFullscreen, state.activeTab]
  );
  const addListItem = handlers.handleAddListItem;
  const handleStatusFilterChange = useCallback(
    (value: string) => setStatusFilter(value as StatusFilterType),
    [setStatusFilter]
  );
  const handleCreateWorkItem = useCallback(() => {
    if (onCreateWorkItem) {
      onCreateWorkItem(
        projectId,
        projectName,
        resolvedProjectSlug ?? projectId
      );
      return;
    }
    void addListItem(WORK_ITEMS_DEFAULT_STATUS);
  }, [
    addListItem,
    onCreateWorkItem,
    projectId,
    projectName,
    resolvedProjectSlug,
  ]);
  const addWorkItemAction =
    state.activeTab !== "Settings" ? handleCreateWorkItem : undefined;
  const settingsContent = (
    <Suspense fallback={<Placeholder variant="loading" />}>
      <WorkItemsSettings
        orgId={displayProject.orgId ?? "personal-org"}
        members={projectData.rawMembers}
        onUpdateMembers={projectData.updateMembers}
        labels={projectData.rawLabels}
        onUpdateLabels={projectData.updateLabels}
        slug={resolvedProjectSlug ?? projectId}
        projectName={projectName}
        workItemPrefix={displayProject.workItemPrefix ?? "PRJ"}
        workItemPrefixCustom={displayProject.workItemPrefixCustom ?? false}
        onUpdateWorkItemPrefix={handleWorkItemPrefixUpdate}
        onDeleteProject={
          canAdministerProjectOrg(displayProject.orgId)
            ? handleDeleteProject
            : undefined
        }
        projectMembers={displayProject.members ?? []}
        onUpdateProjectMembers={handleUpdateProjectMembers}
        onOpenRepoSettings={onOpenRepoSettings}
        sectionRequest={settingsSectionRequest}
      />
    </Suspense>
  );

  const resolvedProjectDescription =
    displayProject.description ?? projectData.project?.description;
  const workItemsHeader = (
    <WorkItemsPageHeader
      projectName={headerTitle}
      breadcrumbSegments={interactiveBreadcrumbSegments}
      identityIcon={projectIdentityIcon}
      onOpenProjects={onOpenProjects}
      activeTab={state.activeTab}
      leadingControls={projectSurfaceControls}
      trailingControls={workItemsSearchControl}
      statusFilter={isWorkItemsSurface ? state.statusFilter : undefined}
      onStatusFilterChange={
        isWorkItemsSurface ? handleStatusFilterChange : undefined
      }
      statusCounts={data.statusCounts}
      statusFilterKeys={statusFilterKeys}
      onCollapseAll={isWorkItemsSurface ? handleCollapseAll : undefined}
      showProperties={
        propertiesActionAvailable ? state.showProperties : undefined
      }
      onToggleProperties={
        propertiesActionAvailable ? handlers.handleToggleProperties : undefined
      }
      onAddProject={
        isWorkItemsSurface && state.activeTab !== "Settings"
          ? onCreateProject
          : undefined
      }
      onAddWorkItem={addWorkItemAction}
      onRefresh={isWorkItemsSurface ? data.refresh : undefined}
      refreshLoading={data.loading}
      endControls={workItemsEndControl}
      splitListHeader={useSplitListHeader}
      splitHeaderLeading={splitHeaderLeading}
      publishToWorkstationHeader={tabBarActionsInStationTabBar && isActive}
      workstationHeaderHost={workstationHeaderHost}
    />
  );

  // The project header stays mounted while the selected work item opens in the
  // reusable right-hand detail pane.
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {!useSplitListHeader && workItemsHeader}

      {/* Content Area */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <WorkItemsTabContent
          statusOrgId={propertyOrgId}
          activeTab={state.activeTab}
          tableColumns={tableColumns}
          onTableColumnsChange={setTableColumns}
          tableSort={tableSort}
          onTableSortChange={setTableSort}
          tablePropertyDefinitions={propertyView.definitions}
          tablePropertyValues={propertyView.values}
          tablePropertyGroupBy={applicablePropertyGroupBy}
          onTablePropertyGroupByChange={handlePropertyGroupByChange}
          groupedWorkItems={propertyGroupedWorkItems}
          filteredWorkItems={propertyFilteredWorkItems}
          selectedWorkItem={data.selectedWorkItem ?? null}
          selectedWorkItemId={state.selectedWorkItemId}
          workItems={data.workItems}
          projectName={displayProject.name}
          projectDescription={resolvedProjectDescription}
          projectProperties={displayProject}
          hideProjectPropertiesRow={
            projectSyncAdapterId === STORY_SYNC_ADAPTER.GITHUB
          }
          repoPath={repoPath}
          availableMembers={projectData.availableMembers}
          availableTeams={projectData.availableTeams}
          projectLabels={projectData.availableLabels}
          availableRepos={availableRepos}
          availableProjects={projectData.availableProjects}
          availableMilestones={projectData.availableMilestones}
          availableLabels={projectData.availableLabels}
          overviewStats={data.overviewStats}
          checkedWorkItemIds={selectedIds}
          onCheckedChange={handleCheckedChange}
          onSelectWorkItem={handleOpenWorkItem}
          onUpdateWorkItem={handlers.handleUpdate}
          onDeleteWorkItem={handleDeleteWorkItem}
          onRestoreWorkItem={handlers.handleRestore}
          onAddListItem={(status: WorkItemStatus) =>
            handlers.handleAddListItem(status)
          }
          onProjectNameChange={handleProjectNameChange}
          onProjectDescriptionChange={handleProjectDescriptionChange}
          onProjectPropertiesChange={handleLocalProjectUpdate}
          onKanbanTaskMove={handlers.handleKanbanTaskMove}
          onKanbanTaskClick={(task) => handleOpenWorkItem(task.id)}
          onAddKanbanTask={handlers.handleAddTask}
          onGanttTaskClick={(task) => handleOpenWorkItem(task.id)}
          onGanttTaskUpdate={handlers.handleGanttTaskUpdate}
          onCalendarEventClick={(event) => handleOpenWorkItem(event.id)}
          kanbanGroupBy={kanbanGroupBy}
          pinnedKanbanColumnIds={pinnedKanbanColumnIds}
          kanbanTasks={propertyKanbanTasks}
          ganttTasks={propertyGanttTasks}
          calendarEvents={propertyCalendarEvents}
          listFullscreen={listFullscreen}
          listHeader={useSplitListHeader ? workItemsHeader : undefined}
          detailContent={detailContent}
          propertiesPanel={propertiesPanel}
          settingsContent={settingsContent}
          collapseAllSignal={collapseAllSignal}
          workItemPrefix={getEffectiveWorkItemPrefix(
            displayProject.name,
            displayProject.workItemPrefix,
            displayProject.workItemPrefixCustom
          )}
        />
      </div>

      <MultiSelectBar
        selectedCount={selectedIds.size}
        visibleItemCount={propertyFilteredWorkItems.length}
        deleting={bulkDeleting}
        onSelectAll={handleSelectAll}
        onUnselectAll={handleUnselectAll}
        onDelete={handleBulkDelete}
        onSetProperty={() => setBatchPropertyOpen(true)}
        onSetStatus={() => setBatchQuickField("status")}
        onSetPriority={() => setBatchQuickField("priority")}
        onSetAssignee={() => setBatchQuickField("assignee")}
      />
      <BatchPropertyDialog
        open={batchPropertyOpen}
        orgId={displayProject.orgId ?? "personal-org"}
        projectSlug={resolvedProjectSlug ?? null}
        shortIds={selectedShortIds}
        members={projectData.availableMembers}
        onClose={() => setBatchPropertyOpen(false)}
        onApplied={() => {
          handleUnselectAll();
          data.refresh();
          void propertyView.refresh();
        }}
      />
      <BatchQuickFieldDialog
        open={batchQuickField !== null}
        field={batchQuickField ?? "status"}
        orgId={displayProject.orgId ?? "personal-org"}
        projectSlug={resolvedProjectSlug}
        shortIds={selectedShortIds}
        members={projectData.availableMembers}
        onClose={() => setBatchQuickField(null)}
        onApplied={() => {
          handleUnselectAll();
          data.refresh();
          void propertyView.refresh();
        }}
      />
      <RevisionConflictModal
        conflict={
          data.revisionConflict
            ? {
                fieldLabel: t(
                  data.revisionConflict.field === "title"
                    ? "workItems.revisionConflict.titleField"
                    : "workItems.revisionConflict.descriptionField"
                ),
                mine: data.revisionConflict.mine,
                latest: data.revisionConflict.latest,
                expectedRevision: data.revisionConflict.expectedRevision,
                actualRevision: data.revisionConflict.actualRevision,
              }
            : null
        }
        onUseLatest={data.useLatestRevisionConflict}
        onKeepMine={data.keepMineRevisionConflict}
      />
    </div>
  );
};

export default WorkItemsPage;
