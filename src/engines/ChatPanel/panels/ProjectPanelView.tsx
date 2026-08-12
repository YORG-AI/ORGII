import { useAtomValue, useSetAtom } from "jotai";
import {
  Box,
  ChevronsRight,
  Columns3,
  Info,
  LayoutDashboard,
  List,
  Search,
} from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { STORY_SYNC_ADAPTER } from "@src/api/http/integrations/syncConnections";
import {
  type MemberEntry,
  type ProjectOrg,
  enrichedWorkItemToUI,
  projectApi,
} from "@src/api/http/project";
import { projectSyncApi } from "@src/api/http/project/sync";
import Button from "@src/components/Button";
import IntegrationIcon from "@src/components/IntegrationIcon";
import Message from "@src/components/Message";
import type { SelectOption } from "@src/components/Select";
import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { ChatLoadingBlock } from "@src/engines/ChatPanel/blocks/primitives";
import { usePublishChatPanelHeader } from "@src/engines/ChatPanel/header";
import KanbanBoard from "@src/features/KanbanBoard";
import type { KanbanTask, TaskStatus } from "@src/features/KanbanBoard";
import { allocateCloudAwareWorkItemId } from "@src/features/Org2Cloud/cloudShortId";
import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { useProjectOrgCloudPermissions } from "@src/features/Org2Cloud/useProjectOrgCloudPermissions";
import { createLogger } from "@src/hooks/logger";
import {
  useCurrentUserMemberIds,
  useProjectDataChanged,
} from "@src/hooks/project";
import WorkItemContentStack from "@src/modules/ProjectManager/WorkItems/components/WorkItemContentStack";
import { MultiSelectBar } from "@src/modules/ProjectManager/WorkItems/components/WorkItemsFooterBars";
import WorkItemsListContent from "@src/modules/ProjectManager/WorkItems/components/WorkItemsListContent";
import WorkItemsStatusFilterSelect from "@src/modules/ProjectManager/WorkItems/components/WorkItemsStatusFilterSelect";
import { useMultiSelect } from "@src/modules/ProjectManager/WorkItems/hooks/useMultiSelect";
import {
  type StatusFilterType,
  WORK_ITEMS_DEFAULT_STATUS,
} from "@src/modules/ProjectManager/WorkItems/types";
import { toWorkItemPartialUpdate } from "@src/modules/ProjectManager/WorkItems/workItemPartialUpdate";
import {
  WORK_ITEMS_KANBAN_GROUP,
  type WorkItemsKanbanGroup,
  countWorkItemsByStatus,
  filterWorkItemsBySearchQuery,
  filterWorkItemsByStatus,
  getStatusFilterKeysForWorkItems,
  getWorkItemsKanbanColumns,
  groupWorkItemsForStatusFilter,
  workItemsToKanbanTasks,
} from "@src/modules/ProjectManager/WorkItems/workItemsViewModel";
import { filterSelectableProjectOrgs } from "@src/modules/ProjectManager/projectOrgVisibility";
import {
  ProjectContentEditor,
  type ProjectData,
  ProjectOrganizationField,
  ProjectPropertyFields,
  PropertiesPanel,
  PropertiesRailFrame,
} from "@src/modules/ProjectManager/shared";
import ProjectManagerBreadcrumb from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import { WorkstationToolbarTooltip } from "@src/modules/WorkStation/shared";
import {
  DetailHeaderTabs,
  DetailPanelContainer,
  DetailTabStrip,
  PersistentDetailTabPanel,
  Placeholder,
  WorkstationTrailIconButton,
  WorkstationTrailSurface,
} from "@src/modules/shared/layouts/blocks";
import { ContentSearchPalette } from "@src/scaffold/GlobalSpotlight/palettes";
import {
  openProjectInChatPanelTabAtom,
  openWorkItemInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { type ChatPanelSelectedProject } from "@src/store/ui/chatPanelAtom";
import type { WorkItem } from "@src/types/core/workItem";

import { resolveChatPanelShortcutOwnership } from "../hooks/chatPanelShortcutOwnership";

const logger = createLogger("ProjectPanelView");

type ProjectPanelTab = "overview" | "list" | "kanban";

interface ProjectPanelViewProps {
  selectedProject: ChatPanelSelectedProject;
}

const PROJECT_PANEL_TABS: ProjectPanelTab[] = ["overview", "list", "kanban"];

function getProjectOverviewDescription(
  project: ChatPanelSelectedProject["project"]
) {
  const description = project.description?.trim() ?? "";
  return description === project.name.trim() ? "" : description;
}

export const ProjectPanelView: React.FC<ProjectPanelViewProps> = ({
  selectedProject,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const openWorkItemTab = useSetAtom(openWorkItemInChatPanelTabAtom);
  const openProjectTab = useSetAtom(openProjectInChatPanelTabAtom);
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const { canAdminister } = useProjectOrgCloudPermissions();
  const sidebarProjectDescription = getProjectOverviewDescription(
    selectedProject.project
  );
  const [activePanelTab, setActivePanelTab] = useState<ProjectPanelTab>("list");
  const [statusFilter, setStatusFilter] = useState<StatusFilterType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [kanbanGroupBy, setKanbanGroupBy] = useState<WorkItemsKanbanGroup>(
    WORK_ITEMS_KANBAN_GROUP.STATUS
  );
  const [projectDescription, setProjectDescription] = useState(
    sidebarProjectDescription
  );
  const [projectBodyLoading, setProjectBodyLoading] = useState(false);
  const [projectBodyError, setProjectBodyError] = useState<string | null>(null);
  const lastSavedDescriptionRef = useRef(sidebarProjectDescription);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [workItemShortIds, setWorkItemShortIds] = useState<Map<string, string>>(
    new Map()
  );
  const [workItemsLoading, setWorkItemsLoading] = useState(false);
  const [workItemsError, setWorkItemsError] = useState<string | null>(null);
  const [projectSyncAdapter, setProjectSyncAdapter] = useState<{
    projectSlug: string;
    adapterId: string | null;
  } | null>(null);
  const [projectOrgs, setProjectOrgs] = useState<ProjectOrg[]>([]);
  const [movingProject, setMovingProject] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const paneOwnsSearchShortcutRef = useRef(true);
  const propertiesRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const updatePaneOwnership = (target: EventTarget | null) => {
      paneOwnsSearchShortcutRef.current = resolveChatPanelShortcutOwnership(
        panelRef.current,
        target,
        paneOwnsSearchShortcutRef.current
      );
    };
    const handlePointerDown = (event: PointerEvent) => {
      updatePaneOwnership(event.target);
    };
    const handleFocusIn = (event: FocusEvent) => {
      updatePaneOwnership(event.target);
    };

    updatePaneOwnership(document.activeElement);
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("focusin", handleFocusIn, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("focusin", handleFocusIn, true);
    };
  }, []);

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if (
        activePanelTab === "overview" ||
        event.key.toLowerCase() !== "f" ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }

      if (!isSearchOpen && !paneOwnsSearchShortcutRef.current) return;

      event.preventDefault();
      event.stopPropagation();
      setIsSearchOpen(true);
    };

    window.addEventListener("keydown", handleSearchShortcut, true);
    return () =>
      window.removeEventListener("keydown", handleSearchShortcut, true);
  }, [activePanelTab, isSearchOpen]);

  const projectProperties = useMemo<ProjectData>(
    () => ({
      id: selectedProject.project.id,
      name: selectedProject.project.name,
      description: selectedProject.project.description,
      slug: selectedProject.project.slug,
      workItemPrefix: selectedProject.project.workItemPrefix,
      workItemPrefixCustom: selectedProject.project.workItemPrefixCustom,
      status: selectedProject.project.status,
      priority: selectedProject.project.priority,
      health: selectedProject.project.health,
      lead: selectedProject.project.lead,
      members: selectedProject.project.members,
      teams: selectedProject.project.teams,
      labels: selectedProject.project.labels,
      linkedRepos: selectedProject.project.linkedRepos?.map((repo) => ({
        id: repo.id,
        name: repo.name,
      })),
      startDate: selectedProject.project.startDate,
      targetDate: selectedProject.project.targetDate,
      completionPercentage: selectedProject.project.completionPercentage,
      statusBreakdown: selectedProject.project.statusBreakdown,
    }),
    [selectedProject.project]
  );
  const projectSlug =
    selectedProject.projectSlug || selectedProject.project.slug;
  const repoPath = selectedProject.project.linkedRepos?.[0]?.path ?? null;
  const projectSyncAdapterId =
    projectSyncAdapter && projectSyncAdapter.projectSlug === projectSlug
      ? projectSyncAdapter.adapterId
      : selectedProject.projectSyncAdapterId;
  const isGitHubSyncedProject =
    projectSyncAdapterId === STORY_SYNC_ADAPTER.GITHUB;
  const projectHeaderBreadcrumb = useMemo(
    () => (
      <ProjectManagerBreadcrumb
        segments={[
          ...(selectedProject.orgName
            ? [{ label: selectedProject.orgName }]
            : []),
          {
            label: selectedProject.project.name,
            icon: isGitHubSyncedProject ? (
              <IntegrationIcon
                type={STORY_SYNC_ADAPTER.GITHUB}
                size={HEADER_ICON_SIZE.sm}
              />
            ) : (
              <Box size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />
            ),
          },
        ]}
      />
    ),
    [
      isGitHubSyncedProject,
      selectedProject.orgName,
      selectedProject.project.name,
    ]
  );

  const toggleProperties = useCallback(() => {
    setPropertiesOpen((current) => !current);
  }, []);
  const propertiesToggleLabel = propertiesOpen
    ? t("projects:workItems.hideProperties")
    : t("projects:workItems.showProperties");
  const headerTrailing = useMemo(
    () => (
      <WorkstationToolbarTooltip label={propertiesToggleLabel}>
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          className={
            propertiesOpen ? "!bg-surface-selected !text-primary-6" : ""
          }
          onClick={toggleProperties}
          aria-label={propertiesToggleLabel}
          data-testid="chat-panel-project-properties-toggle"
          icon={<Info size={HEADER_ICON_SIZE.sm} />}
        />
      </WorkstationToolbarTooltip>
    ),
    [propertiesOpen, propertiesToggleLabel, toggleProperties]
  );

  useEffect(() => {
    if (!projectSlug) return;

    let cancelled = false;
    void projectSyncApi
      .status(projectSlug)
      .then((status) => {
        if (!cancelled) {
          setProjectSyncAdapter({
            projectSlug,
            adapterId: status.adapter_id,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectSyncAdapter({ projectSlug, adapterId: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectSlug]);

  const loadProjectOrgs = useCallback(async () => {
    try {
      setProjectOrgs(await projectApi.readOrgs());
    } catch (error) {
      logger.warn("Failed to load project organizations", error);
    }
  }, []);

  useEffect(() => {
    void loadProjectOrgs();
  }, [loadProjectOrgs]);

  useEffect(() => {
    let cancelled = false;

    if (!projectSlug) {
      setProjectDescription(sidebarProjectDescription);
      lastSavedDescriptionRef.current = sidebarProjectDescription;
      return;
    }

    setProjectBodyLoading(true);
    setProjectBodyError(null);
    void (async () => {
      try {
        const currentProject = await projectApi.readProject(projectSlug);
        if (cancelled) return;
        const nextDescription = currentProject.description.trim();
        setProjectDescription(nextDescription);
        lastSavedDescriptionRef.current = nextDescription;
      } catch (error) {
        if (cancelled) return;
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load project body";
        setProjectBodyError(message);
      } finally {
        if (!cancelled) {
          setProjectBodyLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectSlug, selectedProject.project.id, sidebarProjectDescription]);

  const loadProjectWorkItems = useCallback(async () => {
    if (!projectSlug) {
      setWorkItems([]);
      setWorkItemShortIds(new Map());
      return;
    }

    setWorkItemsLoading(true);
    setWorkItemsError(null);
    try {
      const viewData = await projectApi.readWorkItemsViewData(projectSlug, {
        view: "list",
      });
      setWorkItemShortIds(
        new Map(viewData.items.map((item) => [item.id, item.shortId]))
      );
      setWorkItems(viewData.items.map(enrichedWorkItemToUI));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load work items";
      logger.error("Failed to load project work items:", error);
      setWorkItemsError(message);
    } finally {
      setWorkItemsLoading(false);
    }
  }, [projectSlug]);

  useEffect(() => {
    void loadProjectWorkItems();
  }, [loadProjectWorkItems]);

  useProjectDataChanged(
    useCallback(
      (change) => {
        if (!change?.projectSlug || change.projectSlug === projectSlug) {
          void loadProjectWorkItems();
        }
      },
      [loadProjectWorkItems, projectSlug]
    )
  );

  useEffect(() => {
    if (
      !projectSlug ||
      lastSavedDescriptionRef.current === projectDescription
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          const currentProject = await projectApi.readProject(projectSlug);
          await projectApi.writeProject(
            projectSlug,
            {
              ...currentProject.meta,
              updated_at: new Date().toISOString(),
            },
            projectDescription
          );
          lastSavedDescriptionRef.current = projectDescription;
        } catch (error) {
          logger.error("Failed to save project overview description:", error);
        }
      })();
    }, 500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [projectDescription, projectSlug]);

  const getWorkItemShortId = useCallback(
    (workItemId: string) => workItemShortIds.get(workItemId) ?? null,
    [workItemShortIds]
  );

  const handleDeleteWorkItem = useCallback(
    async (workItemId: string) => {
      if (!projectSlug) return;
      const shortId = getWorkItemShortId(workItemId);
      if (!shortId) return;
      await projectApi.deleteWorkItem(projectSlug, shortId);
      await loadProjectWorkItems();
    },
    [getWorkItemShortId, loadProjectWorkItems, projectSlug]
  );

  const statusCounts = useMemo(
    () => countWorkItemsByStatus(workItems),
    [workItems]
  );

  const statusFilterKeys = useMemo(
    () => getStatusFilterKeysForWorkItems(workItems),
    [workItems]
  );
  useEffect(() => {
    if (!statusFilterKeys.includes(statusFilter)) {
      setStatusFilter("all");
    }
  }, [statusFilter, statusFilterKeys]);

  const filteredWorkItems = useMemo(
    () =>
      filterWorkItemsBySearchQuery(
        filterWorkItemsByStatus(workItems, statusFilter),
        searchQuery
      ),
    [searchQuery, statusFilter, workItems]
  );

  const groupedWorkItems = useMemo(
    () => groupWorkItemsForStatusFilter(filteredWorkItems, statusFilter),
    [filteredWorkItems, statusFilter]
  );

  const workItemPeople = useMemo<MemberEntry[]>(() => {
    const people = new Map<string, MemberEntry>();
    for (const workItem of workItems) {
      for (const person of [workItem.assignee, workItem.createdBy]) {
        if (!person) continue;
        people.set(person.id, {
          id: person.id,
          name: person.name,
          avatar: person.avatar,
          active: true,
        });
      }
    }
    return [...people.values()];
  }, [workItems]);
  const { currentUser, memberIds: currentUserMemberIds } =
    useCurrentUserMemberIds(workItemPeople);
  const pinnedKanbanColumnIds = useMemo(
    () => [...currentUserMemberIds].map((memberId) => `person:${memberId}`),
    [currentUserMemberIds]
  );

  const kanbanTasks = useMemo<KanbanTask[]>(
    () => workItemsToKanbanTasks(filteredWorkItems, kanbanGroupBy),
    [filteredWorkItems, kanbanGroupBy]
  );
  const kanbanColumns = useMemo(
    () =>
      getWorkItemsKanbanColumns(
        filteredWorkItems,
        kanbanGroupBy,
        t("projects:workItems.properties.noAssignee"),
        pinnedKanbanColumnIds
      ),
    [filteredWorkItems, kanbanGroupBy, pinnedKanbanColumnIds, t]
  );

  const {
    selectedIds,
    bulkDeleting,
    handleCheckedChange,
    handleSelectAll,
    handleUnselectAll,
    handleBulkDelete,
  } = useMultiSelect({
    filteredWorkItems,
    onDelete: handleDeleteWorkItem,
    projectSlug,
    getShortId: getWorkItemShortId,
    onBatchDeleteComplete: loadProjectWorkItems,
  });

  const selectableProjectOrgs = useMemo(
    () => filterSelectableProjectOrgs(projectOrgs, cloudOrgs),
    [cloudOrgs, projectOrgs]
  );
  const projectOrgOptions = useMemo<SelectOption[]>(
    () =>
      selectableProjectOrgs.map((org) => ({
        value: org.id,
        label: org.name,
        triggerLabel: org.name,
        dataTestId: `project-org-option-${org.id}`,
      })),
    [selectableProjectOrgs]
  );
  const canMoveProject = canAdminister(selectedProject.orgId);
  const selectedProjectOrgLabel =
    selectableProjectOrgs.find((org) => org.id === selectedProject.orgId)
      ?.name ??
    selectedProject.orgName ??
    selectedProject.orgId;

  const handleProjectOrgChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value) || movingProject || !projectSlug) return;
      const destinationOrgId = String(value);
      if (destinationOrgId === selectedProject.orgId) return;

      void (async () => {
        setMovingProject(true);
        try {
          await projectApi.moveProject(projectSlug, destinationOrgId);
          const destinationOrg = selectableProjectOrgs.find(
            (org) => org.id === destinationOrgId
          );
          openProjectTab({
            ...selectedProject,
            orgId: destinationOrgId,
            orgName: destinationOrg?.name ?? destinationOrgId,
          });
          Message.success(
            `Moved project to ${destinationOrg?.name ?? destinationOrgId}`
          );
        } catch (error) {
          logger.error("Failed to move project", error);
          Message.error(
            error instanceof Error ? error.message : "Failed to move project"
          );
        } finally {
          setMovingProject(false);
        }
      })();
    },
    [
      movingProject,
      openProjectTab,
      projectSlug,
      selectableProjectOrgs,
      selectedProject,
    ]
  );

  const propertiesPanel = (
    <PropertiesRailFrame
      width={300}
      minWidth={280}
      maxWidth={320}
      floatingContent
    >
      <WorkstationTrailSurface className="flex self-start">
        <PropertiesPanel
          title={t("projects:properties.projectProperties")}
          containerRef={propertiesRef}
          fitContent
          headerVariant="workstation-trail"
          headerActions={
            <WorkstationToolbarTooltip label={propertiesToggleLabel}>
              <WorkstationTrailIconButton
                onClick={toggleProperties}
                aria-label={propertiesToggleLabel}
                data-testid="chat-panel-project-properties-collapse"
              >
                <ChevronsRight size={14} strokeWidth={1.75} />
              </WorkstationTrailIconButton>
            </WorkstationToolbarTooltip>
          }
        >
          <div
            title={
              canMoveProject
                ? undefined
                : "Only an organization owner or admin can move this project"
            }
          >
            <ProjectOrganizationField
              value={selectedProject.orgId}
              valueLabel={selectedProjectOrgLabel}
              options={projectOrgOptions}
              onChange={handleProjectOrgChange}
              disabled={!canMoveProject || movingProject}
              dataTestId="project-org-select"
            />
          </div>
          {!isGitHubSyncedProject ? (
            <ProjectPropertyFields
              project={projectProperties}
              containerRef={propertiesRef}
              availableRepos={projectProperties.linkedRepos}
              withGroupInset={false}
              showLabels={false}
            />
          ) : null}
        </PropertiesPanel>
      </WorkstationTrailSurface>
    </PropertiesRailFrame>
  );

  const panelTabItems = useMemo(
    () =>
      PROJECT_PANEL_TABS.map((tab) => ({
        key: tab,
        label:
          tab === "overview"
            ? t("projects:orgs.management.overview")
            : tab === "list"
              ? t("projects:workItems.tabs.list")
              : t("projects:workItems.tabs.kanban"),
        icon:
          tab === "overview" ? (
            <LayoutDashboard size={15} strokeWidth={1.8} />
          ) : tab === "list" ? (
            <List size={15} strokeWidth={1.8} />
          ) : (
            <Columns3 size={15} strokeWidth={1.8} />
          ),
        count: tab === "overview" ? undefined : workItems.length,
      })),
    [t, workItems.length]
  );
  const kanbanGroupTabs = useMemo<TabPillItem[]>(
    () => [
      {
        key: WORK_ITEMS_KANBAN_GROUP.STATUS,
        label: t("projects:projects.groupBy.status"),
      },
      {
        key: WORK_ITEMS_KANBAN_GROUP.ASSIGNED_TO,
        label: t("projects:projects.groupBy.assignedTo"),
      },
      {
        key: WORK_ITEMS_KANBAN_GROUP.CREATED_BY,
        label: t("projects:projects.groupBy.createdBy"),
      },
    ],
    [t]
  );

  const projectHeaderTabs = useMemo(
    () => (
      <DetailTabStrip
        tabs={panelTabItems}
        activeTab={activePanelTab}
        onChange={setActivePanelTab}
        ariaLabel={t("projects:workspace.views")}
        idPrefix="chat-panel-project-detail"
        variant="header"
      />
    ),
    [activePanelTab, panelTabItems, t]
  );
  const projectHeaderContent = useMemo(
    () => (
      <DetailHeaderTabs
        title={projectHeaderBreadcrumb}
        tabs={projectHeaderTabs}
      />
    ),
    [projectHeaderBreadcrumb, projectHeaderTabs]
  );
  const projectHeaderTrailing = useMemo(
    () => (
      <div className="flex shrink-0 items-center gap-1">
        {activePanelTab !== "overview" ? (
          <>
            <WorkstationToolbarTooltip
              label={t("common:actions.search")}
              shortcutId="workitems_search"
            >
              <Button
                htmlType="button"
                variant="tertiary"
                size="small"
                iconOnly
                className={
                  searchQuery ? "!bg-surface-selected !text-primary-6" : ""
                }
                onClick={() => setIsSearchOpen(true)}
                aria-label={t("common:actions.search")}
                aria-pressed={Boolean(searchQuery)}
                icon={<Search size={HEADER_ICON_SIZE.sm} />}
              />
            </WorkstationToolbarTooltip>
            {activePanelTab === "kanban" ? (
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
            ) : null}
            <WorkItemsStatusFilterSelect
              value={statusFilter}
              onChange={setStatusFilter}
              statusCounts={statusCounts}
              filterKeys={statusFilterKeys}
            />
          </>
        ) : null}
        {headerTrailing}
      </div>
    ),
    [
      activePanelTab,
      headerTrailing,
      kanbanGroupBy,
      kanbanGroupTabs,
      searchQuery,
      statusCounts,
      statusFilter,
      statusFilterKeys,
      t,
    ]
  );

  // Memoize the published-header payload — a fresh object literal every
  // render re-publishes on every commit and can drive an unbounded update
  // loop through the header atom's subscriber (see WorkItemPanelView).
  const publishedHeader = useMemo(
    () => ({
      content: projectHeaderContent,
      trailing: projectHeaderTrailing,
    }),
    [projectHeaderContent, projectHeaderTrailing]
  );
  usePublishChatPanelHeader({ content: publishedHeader });

  const handleSelectWorkItem = useCallback(
    (workItemId: string) => {
      const workItem = workItems.find((item) => item.session_id === workItemId);
      if (!workItem) return;
      openWorkItemTab({
        workItem,
        projectId: selectedProject.project.id,
        projectName: selectedProject.project.name,
        projectSlug: projectSlug ?? selectedProject.projectSlug,
        shortId: workItemShortIds.get(workItemId) ?? workItemId,
        orgId: selectedProject.orgId,
        orgName: selectedProject.orgName,
        sourceProject: selectedProject,
      });
    },
    [projectSlug, selectedProject, openWorkItemTab, workItemShortIds, workItems]
  );

  const handleSelectWorkItemFromKanban = useCallback(
    (task: KanbanTask) => {
      handleSelectWorkItem(task.id);
    },
    [handleSelectWorkItem]
  );

  const handleUpdateWorkItem = useCallback(
    async (workItemId: string, updates: Partial<WorkItem>) => {
      if (!projectSlug) return;
      const shortId = getWorkItemShortId(workItemId);
      if (!shortId) return;

      const payload = toWorkItemPartialUpdate(updates, currentUser);
      if (Object.keys(payload).length === 0) return;

      const updated = await projectApi.updateWorkItemPartial(
        projectSlug,
        shortId,
        payload
      );
      const updatedItem = enrichedWorkItemToUI(updated);
      setWorkItems((currentItems) =>
        currentItems.map((item) =>
          item.session_id === workItemId ? updatedItem : item
        )
      );
    },
    [currentUser, getWorkItemShortId, projectSlug, setWorkItems]
  );

  const handleAddKanbanTask = useCallback(
    async (status: TaskStatus) => {
      if (!projectSlug) return;
      // Collab-synced orgs allocate on the server (design §16.5) — a local
      // counter here could mint the same PREFIX-n as a teammate and merge
      // two distinct work items on push.
      const shortId = await allocateCloudAwareWorkItemId(projectSlug);
      // Canonical work.create: the Rust service owns row construction.
      await projectApi.createWorkItem(projectSlug, shortId, {
        title: t("projects:workItems.newWorkItemName", {
          defaultValue: "New Work Item",
        }),
        projectId: selectedProject.project.id,
        status: status || WORK_ITEMS_DEFAULT_STATUS,
      });
      await loadProjectWorkItems();
    },
    [loadProjectWorkItems, projectSlug, selectedProject.project.id, t]
  );

  const handleDescriptionChange = useCallback((markdown: string) => {
    setProjectDescription(markdown);
  }, []);

  const overviewContent = projectBodyLoading ? (
    <div className="p-2">
      <ChatLoadingBlock />
    </div>
  ) : projectBodyError ? (
    <Placeholder variant="error" title={projectBodyError} fillParentHeight />
  ) : (
    <section data-testid="chat-panel-project-overview-section">
      <ProjectContentEditor
        key={projectSlug}
        title={selectedProject.project.name}
        onTitleChange={() => undefined}
        initialDescription={projectDescription}
        onDescriptionChange={handleDescriptionChange}
        titleVisible={false}
        separatorVisible={false}
        descriptionPlaceholder={t("workItems.overview.descriptionPlaceholder")}
        editable
        descriptionClassName="no-bottom-border"
        repoPath={repoPath}
        className="w-full"
      />
    </section>
  );

  const workItemsUnavailableContent = workItemsLoading ? (
    <div className="p-2">
      <ChatLoadingBlock />
    </div>
  ) : workItemsError ? (
    <Placeholder
      variant="error"
      title={workItemsError}
      fillParentHeight
      action={{
        label: t("common:actions.retry"),
        onClick: loadProjectWorkItems,
      }}
    />
  ) : null;

  const listContent = workItemsUnavailableContent ?? (
    <div className="h-full min-h-0 flex-1 overflow-hidden">
      <WorkItemsListContent
        groupedWorkItems={groupedWorkItems}
        filteredWorkItems={filteredWorkItems}
        workItems={workItems}
        selectedWorkItemId={null}
        availableMembers={selectedProject.project.members ?? []}
        availableProjects={[
          {
            id: selectedProject.project.id,
            name: selectedProject.project.name,
          },
        ]}
        availableLabels={selectedProject.project.labels ?? []}
        checkedWorkItemIds={selectedIds}
        onCheckedChange={handleCheckedChange}
        onSelectWorkItem={handleSelectWorkItem}
        readonly
        disableProjectEdit
        compactRows
        workItemPrefix={selectedProject.project.workItemPrefix}
      />
    </div>
  );

  const kanbanContent = workItemsUnavailableContent ?? (
    <div className="h-full min-h-0 flex-1 overflow-hidden">
      <div className="h-full min-h-0">
        <KanbanBoard
          tasks={kanbanTasks}
          columnOrder={kanbanColumns}
          allowColumnReorder={false}
          allowTaskDrag={kanbanGroupBy === WORK_ITEMS_KANBAN_GROUP.STATUS}
          onTaskMove={(taskId: string, newStatus: TaskStatus) => {
            if (kanbanGroupBy !== WORK_ITEMS_KANBAN_GROUP.STATUS) return;
            void handleUpdateWorkItem(taskId, {
              workItemStatus: newStatus as WorkItem["workItemStatus"],
            });
          }}
          onTaskClick={handleSelectWorkItemFromKanban}
          onAddTask={(status: TaskStatus) => {
            void handleAddKanbanTask(status);
          }}
          showAddButton={kanbanGroupBy === WORK_ITEMS_KANBAN_GROUP.STATUS}
          className="kanban-board--linear"
        />
      </div>
    </div>
  );

  const descriptionContent = (
    <section
      className="flex min-h-0 flex-1 flex-col"
      data-testid="chat-panel-project-section"
    >
      <PersistentDetailTabPanel
        active={activePanelTab === "overview"}
        id="chat-panel-project-detail-tabpanel-overview"
        ariaLabelledBy="chat-panel-project-detail-tab-overview"
        className="flex-col overflow-y-auto overflow-x-hidden scrollbar-hide"
      >
        {overviewContent}
      </PersistentDetailTabPanel>
      <PersistentDetailTabPanel
        active={activePanelTab === "list"}
        id="chat-panel-project-detail-tabpanel-list"
        ariaLabelledBy="chat-panel-project-detail-tab-list"
        className="flex-col overflow-hidden"
      >
        {listContent}
      </PersistentDetailTabPanel>
      <PersistentDetailTabPanel
        active={activePanelTab === "kanban"}
        id="chat-panel-project-detail-tabpanel-kanban"
        ariaLabelledBy="chat-panel-project-detail-tab-kanban"
        className="flex-col overflow-hidden"
      >
        {kanbanContent}
      </PersistentDetailTabPanel>
    </section>
  );

  return (
    <div
      ref={panelRef}
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="chat-panel-project-detail"
    >
      <ContentSearchPalette
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        query={searchQuery}
        onQueryChange={setSearchQuery}
        placeholder={t("common:actions.search")}
      />
      <DetailPanelContainer className="relative">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <WorkItemContentStack
            descriptionContent={descriptionContent}
            descriptionFlexible
            className="min-w-0"
            descriptionClassName="min-h-0 flex flex-1 flex-col"
          />
          {propertiesOpen ? propertiesPanel : null}
        </div>
        {activePanelTab !== "overview" ? (
          <MultiSelectBar
            selectedCount={selectedIds.size}
            visibleItemCount={workItems.length}
            deleting={bulkDeleting}
            centeredActions
            onSelectAll={handleSelectAll}
            onUnselectAll={handleUnselectAll}
            onDelete={handleBulkDelete}
          />
        ) : null}
      </DetailPanelContainer>
    </div>
  );
};

export default ProjectPanelView;
