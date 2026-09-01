/**
 * Projects Page
 *
 * Lists projects from the centralized `.orgii` project store.
 * "Add Project" opens in a separate tab (handled by ProjectManagerLayout).
 * Repo settings are a separate tab — this page is list-only.
 */
import { emit } from "@tauri-apps/api/event";
import { useAtomValue } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { STORY_SYNC_ADAPTER } from "@src/api/http/integrations/syncConnections";
import {
  type LabelEntry,
  type MemberEntry,
  projectApi,
  projectDataToUI,
  projectSyncApi,
} from "@src/api/http/project";
import { HeaderSectionSeparator } from "@src/components/HeaderSectionSeparator";
import Message from "@src/components/Message";
import { Placeholder } from "@src/components/Placeholder";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import { ROUTES } from "@src/config/routes";
import { useProjectOrgCloudPermissions } from "@src/features/Org2Cloud/useProjectOrgCloudPermissions";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";
import {
  CircleIcon,
  Flag01Icon,
  HugeiconsIcon,
  TimeScheduleIcon,
} from "@src/icons";
import type { LinearProjectSelection } from "@src/modules/ProjectManager/Panels/ProjectManagerSidebar/content/WorkspaceTreeContent";
import WorkItemSection from "@src/modules/ProjectManager/WorkItems/components/WorkItemSection";
import { MultiSelectBar } from "@src/modules/ProjectManager/WorkItems/components/WorkItemsFooterBars";
import { getProjectStatusConfig } from "@src/modules/ProjectManager/config/manage";
import { useProjectManagerWorkItemsTabBarRegistration } from "@src/modules/ProjectManager/hooks/useProjectManagerWorkItemsTabBarRegistration";
import type { ProjectManagerBreadcrumbSegment } from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import VirtualizedGroupedList from "@src/modules/ProjectManager/shared/components/VirtualizedGroupedList";
import { PROJECT_MANAGER_PLACEHOLDER_PLACEMENT } from "@src/modules/ProjectManager/shared/placeholderTokens";
import {
  WORKSPACE_SOURCE,
  type WorkspaceProject,
  loadWorkspaceLinearProjects,
} from "@src/modules/ProjectManager/workspaceAggregate";
import { ContentSearchPalette } from "@src/scaffold/GlobalSpotlight/palettes";
import { projectListRefreshAtom } from "@src/store/project/projectAtom";
import type { Project } from "@src/types/core/project";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import { ProjectRow, ProjectsPageHeader } from "./components";
import {
  type ProjectsGroupMode,
  type WorkspaceSourceMode,
} from "./projectsUtils";
import { useProjectsGrouping } from "./useProjectsGrouping";

const log = createLogger("ProjectsPage");

// ============================================
// Types
// ============================================

// Stable base shape used as a DropdownOption foundation for non-status groups.
// value/color/icon are always overridden by the group; only label/bgColor are
// inherited (WorkItemSection only reads color and icon from statusConfig).
const SECTION_BASE_CONFIG = getProjectStatusConfig("planned");

interface ProjectsPageProps {
  breadcrumbSegments?: readonly ProjectManagerBreadcrumbSegment[];
  /** Callback to open a project as a tab (in the unified tab system) */
  onOpenProject?: (
    projectId: string,
    projectName: string,
    projectSlug?: string
  ) => void;
  /** Callback to open the "New Project" tab */
  onAddProject?: () => void;
  /** Callback to open a Linear project when Workspace includes Linear rows. */
  onOpenLinearProject?: (selection: LinearProjectSelection) => void;
  orgId?: string;
  allowExternalSources?: boolean;
  /** Publish page controls into the global WorkstationTabHeader. */
  publishToWorkstationHeader?: boolean;
  /** Workstation tab id used to publish tab-bar trailing controls. */
  workStationTabId?: string;
  /** Host slot used by the global WorkstationTabHeader. */
  workstationHeaderHost?: "project" | "workManagement";
  /** Org hub surface pills shown after the breadcrumb (Overview / Projects / …). */
  orgSurfaceControls?: React.ReactNode;
}

const EMPTY_LABEL_MAP = new Map<string, LabelEntry>();
const EMPTY_MEMBER_MAP = new Map<string, MemberEntry>();

// ============================================
// Component
// ============================================

const ProjectsPage: React.FC<ProjectsPageProps> = ({
  breadcrumbSegments,
  onOpenProject,
  onAddProject,
  onOpenLinearProject,
  orgId,
  allowExternalSources = false,
  publishToWorkstationHeader = false,
  workStationTabId,
  workstationHeaderHost = "project",
  orgSurfaceControls,
}) => {
  const { t } = useTranslation("projects");
  const navigate = useNavigate();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [groupMode, setGroupMode] = useState<ProjectsGroupMode>("status");
  const [collapseAllSignal, setCollapseAllSignal] = useState(0);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(
    new Set()
  );
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [unlinkingProjectId, setUnlinkingProjectId] = useState<string | null>(
    null
  );
  const [workspaceSourceMode, setWorkspaceSourceMode] =
    useState<WorkspaceSourceMode>("local_only");

  const pageTitle = t("projects.dashboardTitle");
  const includeExternalSources =
    allowExternalSources && workspaceSourceMode === "include_external";

  // Watch for refresh signals after project creation or deletion
  const refreshSignal = useAtomValue(projectListRefreshAtom);

  useEffect(() => {
    if (!allowExternalSources) {
      setWorkspaceSourceMode("local_only");
    }
  }, [allowExternalSources]);

  const [fileProjects, setFileProjects] = useState<WorkspaceProject[]>([]);
  const [fileProjectsLoading, setFileProjectsLoading] = useState(false);
  const [fileProjectsLoaded, setFileProjectsLoaded] = useState(false);
  const fileProjectsLoadedRef = useRef(false);
  const loadLifecycleRef = useRef({ mounted: true, generation: 0 });
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    const lifecycle = loadLifecycleRef.current;
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      lifecycle.generation += 1;
    };
  }, []);

  const loadProjectsForRepo = useCallback(async () => {
    const generation = ++loadLifecycleRef.current.generation;
    const isCurrent = () => {
      const lifecycle = loadLifecycleRef.current;
      return lifecycle.mounted && lifecycle.generation === generation;
    };
    setFileProjectsLoading(true);
    setFileError(null);
    try {
      const [projectsData, linearProjects] = await Promise.all([
        projectApi.readProjects({ orgId }),
        includeExternalSources ? loadWorkspaceLinearProjects() : [],
      ]);
      if (!isCurrent()) return;
      const localProjects = projectsData.map((project) =>
        projectDataToUI(project, {
          labelMap: EMPTY_LABEL_MAP,
          memberMap: EMPTY_MEMBER_MAP,
        })
      );
      setFileProjects([...localProjects, ...linearProjects]);
      fileProjectsLoadedRef.current = true;
      setFileProjectsLoaded(true);
    } catch (err) {
      if (!isCurrent()) return;
      log.error("[ProjectsPage] Failed to load projects:", err);
      if (!fileProjectsLoadedRef.current) {
        setFileProjects([]);
      }
      setFileError(
        err instanceof Error ? err.message : t("projects.loadProjectsFailed")
      );
    } finally {
      if (isCurrent()) setFileProjectsLoading(false);
    }
  }, [includeExternalSources, orgId, t]);

  const loadFileProjects = useCallback(async () => {
    await loadProjectsForRepo();
  }, [loadProjectsForRepo]);

  useEffect(() => {
    void loadProjectsForRepo();
  }, [loadProjectsForRepo, refreshSignal]);

  useProjectDataChanged(
    useCallback(() => {
      void loadFileProjects();
    }, [loadFileProjects])
  );

  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return fileProjects;
    const query = searchQuery.toLowerCase();
    return fileProjects.filter((project) => {
      const name = project.name.toLowerCase();
      const description = (project.description || "").toLowerCase();
      return name.includes(query) || description.includes(query);
    });
  }, [fileProjects, searchQuery]);

  const groupModeOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: "status",
        label: (
          <span className="flex items-center gap-2 whitespace-nowrap">
            <HugeiconsIcon
              icon={CircleIcon}
              data-icon="circle"
              size={13}
              strokeWidth={1.75}
            />
            <span>{t("projects.groupBy.status")}</span>
          </span>
        ),
        triggerLabel: t("projects.groupBy.status"),
      },
      {
        value: "priority",
        label: (
          <span className="flex items-center gap-2 whitespace-nowrap">
            <HugeiconsIcon
              icon={Flag01Icon}
              data-icon="flag"
              size={13}
              strokeWidth={1.75}
            />
            <span>{t("projects.groupBy.priority")}</span>
          </span>
        ),
        triggerLabel: t("projects.groupBy.priority"),
      },
      {
        value: "targetDate",
        label: (
          <span className="flex items-center gap-2 whitespace-nowrap">
            <HugeiconsIcon
              icon={TimeScheduleIcon}
              data-icon="calendar-clock"
              size={13}
              strokeWidth={1.75}
            />
            <span>{t("projects.groupBy.targetDate")}</span>
          </span>
        ),
        triggerLabel: t("projects.groupBy.targetDate"),
      },
    ],
    [t]
  );

  const groupedProjects = useProjectsGrouping({ filteredProjects, groupMode });
  const { canAdminister: canAdministerProjectOrg } =
    useProjectOrgCloudPermissions();

  // Linear rows are read-only. Managed-cloud projects additionally require
  // an owner/admin role; the backend remains authoritative, while this gate
  // keeps forbidden single and bulk delete controls out of the member UX.
  const isProjectDeletable = useCallback(
    (project: WorkspaceProject) =>
      project.workspaceSource?.source !== WORKSPACE_SOURCE.LINEAR &&
      canAdministerProjectOrg(project.orgId),
    [canAdministerProjectOrg]
  );

  const isProjectSourceUnlinkable = useCallback(
    (project: WorkspaceProject) =>
      project.workspaceSource?.source !== WORKSPACE_SOURCE.LINEAR &&
      project.syncAdapterId === STORY_SYNC_ADAPTER.GITHUB &&
      Boolean(project.slug) &&
      canAdministerProjectOrg(project.orgId),
    [canAdministerProjectOrg]
  );

  const showCheckboxesOnAllRows = selectedProjectIds.size > 0;
  const selectableFilteredProjectCount = useMemo(
    () => filteredProjects.filter(isProjectDeletable).length,
    [filteredProjects, isProjectDeletable]
  );

  const loading = fileProjectsLoading;
  const showInitialLoading = loading && !fileProjectsLoaded;

  // ---- Navigation ----

  const handleProjectClick = useCallback(
    (projectId: string) => {
      const project = fileProjects.find((item) => item.id === projectId);
      if (
        project?.workspaceSource?.source === WORKSPACE_SOURCE.LINEAR &&
        onOpenLinearProject
      ) {
        onOpenLinearProject({
          connectionId: project.workspaceSource.connectionId,
          projectId: project.workspaceSource.projectId,
          projectName: project.workspaceSource.projectName,
          teamId: project.workspaceSource.teamId,
          teamName: project.workspaceSource.teamName,
        });
        return;
      }

      if (onOpenProject) {
        const name = project?.name ?? projectId;
        onOpenProject(projectId, name, project?.slug);
      } else {
        navigate(`${ROUTES.workStation.project.path}?project=${projectId}`);
      }
    },
    [onOpenLinearProject, onOpenProject, fileProjects, navigate]
  );

  const handleOpenSearch = useCallback(() => {
    setSearchQuery("");
    setIsSearchOpen(true);
  }, []);

  const handleCloseSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery("");
  }, []);

  const handleRefresh = useCallback(() => {
    loadFileProjects();
  }, [loadFileProjects]);

  const handleCollapseAll = useCallback(() => {
    setCollapseAllSignal((currentSignal) => currentSignal + 1);
  }, []);

  const handleProjectCheckedChange = useCallback(
    (projectId: string, checked: boolean) => {
      const project = fileProjects.find((item) => item.id === projectId);
      if (project && !isProjectDeletable(project)) return;
      setSelectedProjectIds((previous) => {
        const next = new Set(previous);
        if (checked) {
          next.add(projectId);
        } else {
          next.delete(projectId);
        }
        return next;
      });
    },
    [fileProjects, isProjectDeletable]
  );

  const handleSelectAllProjects = useCallback(() => {
    setSelectedProjectIds(
      new Set(
        filteredProjects.filter(isProjectDeletable).map((project) => project.id)
      )
    );
  }, [filteredProjects, isProjectDeletable]);

  const handleUnselectAllProjects = useCallback(() => {
    setSelectedProjectIds(new Set());
  }, []);

  const handleBulkDeleteProjects = useCallback(async () => {
    const projectIds = Array.from(selectedProjectIds);
    if (projectIds.length === 0) return;

    const confirmed = await confirmDestructiveAction({
      title: t("common:actions.confirmDelete"),
      message: t("common:actions.confirmDeleteMessage"),
      okLabel: t("common:actions.delete"),
      cancelLabel: t("common:actions.cancel"),
    });
    if (!confirmed) return;

    setBulkDeleting(true);
    try {
      const projectById = new Map(
        fileProjects.map((project) => [project.id, project])
      );
      for (const projectId of projectIds) {
        const project = projectById.get(projectId);
        if (!project) continue;
        // Defensive re-check: the collab role may have changed between
        // selection and delete (see isProjectDeletable above).
        if (!isProjectDeletable(project)) continue;
        const slug =
          project.slug ||
          project.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
        await projectApi.deleteProject(slug);
      }
      await emit("orgii-data-changed");
      setSelectedProjectIds(new Set());
      await loadFileProjects();
    } finally {
      setBulkDeleting(false);
    }
  }, [
    selectedProjectIds,
    t,
    fileProjects,
    isProjectDeletable,
    loadFileProjects,
  ]);

  const handleDeleteProject = useCallback(
    async (project: Project) => {
      const slug =
        project.slug ||
        project.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
      await projectApi.deleteProject(slug);
      await emit("orgii-data-changed");
      setSelectedProjectIds((previous) => {
        const next = new Set(previous);
        next.delete(project.id);
        return next;
      });
      await loadFileProjects();
    },
    [loadFileProjects]
  );

  const handleUnlinkProjectSource = useCallback(
    async (project: WorkspaceProject) => {
      if (
        unlinkingProjectId !== null ||
        !project.slug ||
        !isProjectSourceUnlinkable(project)
      ) {
        return;
      }

      const confirmed = await confirmDestructiveAction({
        title: t("settings.sync.adapterPicker.detachProjectTitle", {
          project: project.name,
        }),
        message: t("settings.sync.adapterPicker.detachProjectDescription"),
        okLabel: t("settings.sync.adapterPicker.detachProjectMenuLabel"),
        cancelLabel: t("common:actions.cancel"),
      });
      if (!confirmed) return;

      setUnlinkingProjectId(project.id);
      try {
        await projectSyncApi.detachAdapter(project.slug);
        setSelectedProjectIds((previous) => {
          const next = new Set(previous);
          next.delete(project.id);
          return next;
        });
        await loadFileProjects();
        Message.success(
          t("settings.sync.adapterPicker.detachProjectSuccess", {
            project: project.name,
          })
        );
      } catch (error) {
        Message.error(
          t("settings.sync.errors.detachFailed", {
            error: error instanceof Error ? error.message : String(error),
          })
        );
      } finally {
        setUnlinkingProjectId(null);
      }
    },
    [isProjectSourceUnlinkable, loadFileProjects, t, unlinkingProjectId]
  );

  const handleGroupModeChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value)) return;
      setGroupMode(value as ProjectsGroupMode);
    },
    []
  );

  const workspaceSourceTabs = useMemo<TabPillItem[]>(
    () => [
      { key: "local_only", label: t("projects.source.localOnly") },
      {
        key: "include_external",
        label: t("projects.source.includeExternal"),
      },
    ],
    [t]
  );

  const handleWorkspaceSourceModeChange = useCallback((key: string) => {
    setWorkspaceSourceMode(key as WorkspaceSourceMode);
  }, []);

  const groupModeSelect = useMemo(
    () => (
      <Select
        value={groupMode}
        onChange={handleGroupModeChange}
        options={groupModeOptions}
        size="small"
        appearance="ghost"
        radius="lg"
        dropdownWidthMode="auto"
        dropdownAlign="left"
        className="w-auto"
      />
    ),
    [groupMode, groupModeOptions, handleGroupModeChange]
  );

  const sourceModeSwitch = useMemo(() => {
    if (!allowExternalSources) return null;
    return (
      <TabPill
        tabs={workspaceSourceTabs}
        activeTab={workspaceSourceMode}
        onChange={handleWorkspaceSourceModeChange}
        variant="pill"
        color="fill"
        fillWidth={false}
        size="small"
      />
    );
  }, [
    allowExternalSources,
    handleWorkspaceSourceModeChange,
    workspaceSourceMode,
    workspaceSourceTabs,
  ]);

  const headerLeadingControls = useMemo(
    () => (
      <div className="contents">
        {orgSurfaceControls}
        {orgSurfaceControls && <HeaderSectionSeparator />}
        {groupModeSelect}
        {sourceModeSwitch && <HeaderSectionSeparator />}
        {sourceModeSwitch}
      </div>
    ),
    [groupModeSelect, orgSurfaceControls, sourceModeSwitch]
  );

  const virtualProjectGroups = useMemo(
    () =>
      groupedProjects.map((group) => ({
        key: group.key,
        group,
        items: group.projects,
      })),
    [groupedProjects]
  );

  const defaultProjectGroupExpanded = useCallback(
    () => collapseAllSignal === 0,
    [collapseAllSignal]
  );

  useProjectManagerWorkItemsTabBarRegistration({
    workStationTabId,
    enabled: publishToWorkstationHeader,
    showPropertiesActive: false,
    onSearch: handleOpenSearch,
    onRefresh: handleRefresh,
    refreshLoading: loading,
    onToggleProperties: null,
    onAddProject,
    onAddWorkItem: null,
  });

  // ============================================
  // Render
  // ============================================

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ProjectsPageHeader
        title={pageTitle}
        breadcrumbSegments={breadcrumbSegments}
        onSearch={publishToWorkstationHeader ? undefined : handleOpenSearch}
        onCollapseAll={handleCollapseAll}
        onRefresh={handleRefresh}
        onAddProject={onAddProject}
        refreshLoading={loading}
        leadingControls={headerLeadingControls}
        publishToWorkstationHeader={publishToWorkstationHeader}
        workstationHeaderHost={workstationHeaderHost}
      />

      {/* Content search spotlight */}
      <ContentSearchPalette
        isOpen={isSearchOpen}
        onClose={handleCloseSearch}
        query={searchQuery}
        onQueryChange={setSearchQuery}
        placeholder={t("projects.searchPlaceholder")}
      />

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide">
            {showInitialLoading ? (
              <Placeholder
                variant="loading"
                placement={PROJECT_MANAGER_PLACEHOLDER_PLACEMENT}
                title={t("projects.loading")}
                fillParentHeight
              />
            ) : fileError && fileProjects.length === 0 ? (
              <Placeholder
                variant="error"
                placement={PROJECT_MANAGER_PLACEHOLDER_PLACEMENT}
                title={fileError}
                fillParentHeight
              />
            ) : filteredProjects.length === 0 ? (
              <Placeholder
                variant={fileProjects.length === 0 ? "empty" : "no-results"}
                placement={PROJECT_MANAGER_PLACEHOLDER_PLACEMENT}
                title={
                  fileProjects.length === 0
                    ? t("projects.emptyState")
                    : t("projects.noResults")
                }
                subtitle={
                  fileProjects.length === 0
                    ? t("projects.emptyStateSubtitle")
                    : undefined
                }
                action={
                  fileProjects.length === 0 && onAddProject
                    ? {
                        label: t("projects.createFirstProject"),
                        onClick: onAddProject,
                      }
                    : undefined
                }
                fillParentHeight
              />
            ) : (
              <VirtualizedGroupedList
                key={collapseAllSignal}
                testId="projects-virtual-list"
                groups={virtualProjectGroups}
                defaultExpanded={defaultProjectGroupExpanded}
                getItemKey={(project) => project.id}
                renderGroupHeader={(group, expanded, onExpandedChange) => (
                  <WorkItemSection
                    status={group.key}
                    statusConfig={{
                      ...SECTION_BASE_CONFIG,
                      value: group.key,
                      color: group.color,
                      icon: group.icon,
                    }}
                    label={group.label}
                    count={group.projects.length}
                    expanded={expanded}
                    onExpandedChange={onExpandedChange}
                    virtualizedHeader
                    variant="table"
                  />
                )}
                renderItem={(project) => (
                  <div>
                    <ProjectRow
                      project={project}
                      isSelected={false}
                      variant="table"
                      isChecked={selectedProjectIds.has(project.id)}
                      showCheckboxes={showCheckboxesOnAllRows}
                      onSelect={handleProjectClick}
                      onCheckedChange={handleProjectCheckedChange}
                      onUnlinkSource={
                        isProjectSourceUnlinkable(project)
                          ? () => void handleUnlinkProjectSource(project)
                          : undefined
                      }
                      unlinkingSource={unlinkingProjectId === project.id}
                      onDelete={
                        isProjectDeletable(project)
                          ? handleDeleteProject
                          : undefined
                      }
                    />
                  </div>
                )}
              />
            )}
          </div>
        </div>
      </div>

      <MultiSelectBar
        selectedCount={selectedProjectIds.size}
        visibleItemCount={selectableFilteredProjectCount}
        deleting={bulkDeleting}
        onSelectAll={handleSelectAllProjects}
        onUnselectAll={handleUnselectAllProjects}
        onDelete={handleBulkDeleteProjects}
      />
    </div>
  );
};

export default ProjectsPage;
