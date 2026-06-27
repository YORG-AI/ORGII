import { useSetAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { enrichedWorkItemToUI, projectApi } from "@src/api/http/project";
import TabPill from "@src/components/TabPill";
import {
  ChatPanelHeaderBreadcrumb,
  usePublishChatPanelHeader,
} from "@src/engines/ChatPanel/header";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";
import WorkItemContentStack from "@src/modules/ProjectManager/WorkItems/components/WorkItemContentStack";
import { MultiSelectBar } from "@src/modules/ProjectManager/WorkItems/components/WorkItemsFooterBars";
import WorkItemsListContent from "@src/modules/ProjectManager/WorkItems/components/WorkItemsListContent";
import { useMultiSelect } from "@src/modules/ProjectManager/WorkItems/hooks/useMultiSelect";
import { groupWorkItemsForStatusFilter } from "@src/modules/ProjectManager/WorkItems/workItemsViewModel";
import {
  PROJECT_PROPERTY_CONCISE_FIELDS,
  ProjectContentEditor,
  type ProjectData,
  ProjectPropertyFields,
} from "@src/modules/ProjectManager/shared";
import {
  DetailPanelContainer,
  Placeholder,
} from "@src/modules/shared/layouts/blocks";
import {
  CHAT_PANEL_SURFACE_KIND,
  type ChatPanelSelectedProject,
  chatPanelNavigateAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  STORY_ORG_SCOPE,
  STORY_PERSONAL_ORG_FILTER_ID,
} from "@src/store/workstation";
import type { WorkItem } from "@src/types/core/workItem";

const logger = createLogger("ProjectPanelView");

type ProjectPanelTab = "overview" | "workItems";

interface ProjectPanelViewProps {
  selectedProject: ChatPanelSelectedProject;
}

const PROJECT_PANEL_TABS: ProjectPanelTab[] = ["overview", "workItems"];

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
  const navigateChatPanel = useSetAtom(chatPanelNavigateAtom);
  const sidebarProjectDescription = getProjectOverviewDescription(
    selectedProject.project
  );
  const [activePanelTab, setActivePanelTab] =
    useState<ProjectPanelTab>("overview");
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
  const propertiesRef = useRef<HTMLDivElement>(null);

  const orgPathLabel =
    selectedProject.orgName || t("projects:orgs.personalOrg");
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
      const viewData = await projectApi.readWorkItemsViewData(projectSlug);
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
    useCallback(() => {
      void loadProjectWorkItems();
    }, [loadProjectWorkItems])
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

  const {
    selectedIds,
    bulkDeleting,
    handleCheckedChange,
    handleSelectAll,
    handleUnselectAll,
    handleBulkDelete,
  } = useMultiSelect({
    filteredWorkItems: workItems,
    onDelete: handleDeleteWorkItem,
    projectSlug,
    getShortId: getWorkItemShortId,
    onBatchDeleteComplete: loadProjectWorkItems,
  });

  const handleOpenOrg = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      navigateChatPanel({
        kind: CHAT_PANEL_SURFACE_KIND.PROJECT_ORG,
        projectOrg: {
          orgId: selectedProject.orgId,
          orgName: orgPathLabel,
          orgScope:
            selectedProject.orgId === STORY_PERSONAL_ORG_FILTER_ID
              ? STORY_ORG_SCOPE.PERSONAL_ORG
              : STORY_ORG_SCOPE.PROJECT_ORG,
        },
      });
    },
    [navigateChatPanel, orgPathLabel, selectedProject.orgId]
  );

  const handleOpenProjectOverview = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      setActivePanelTab("overview");
    },
    []
  );

  const headerBreadcrumbContent = useMemo(
    () => (
      <ChatPanelHeaderBreadcrumb
        items={[
          {
            key: "org",
            label: orgPathLabel,
            onClick: handleOpenOrg,
          },
          {
            key: "project",
            label: selectedProject.project.name,
            onClick: handleOpenProjectOverview,
          },
        ]}
      />
    ),
    [
      handleOpenOrg,
      handleOpenProjectOverview,
      orgPathLabel,
      selectedProject.project.name,
    ]
  );

  usePublishChatPanelHeader({
    content: { content: headerBreadcrumbContent },
  });

  const inlineProperties = (
    <div ref={propertiesRef}>
      <ProjectPropertyFields
        project={projectProperties}
        containerRef={propertiesRef}
        fieldVariant="pill"
        visibleFields={PROJECT_PROPERTY_CONCISE_FIELDS}
        availableRepos={projectProperties.linkedRepos}
        showMoreMenu
      />
    </div>
  );

  const panelTabItems = PROJECT_PANEL_TABS.map((tab) => ({
    key: tab,
    label:
      tab === "overview"
        ? t("projects:orgs.management.overview")
        : t("projects:workItems.label"),
  }));

  const handleSelectWorkItem = useCallback(
    (workItemId: string) => {
      const workItem = workItems.find((item) => item.session_id === workItemId);
      if (!workItem) return;
      navigateChatPanel({
        kind: CHAT_PANEL_SURFACE_KIND.WORK_ITEM,
        workItem: {
          workItem,
          projectId: selectedProject.project.id,
          projectName: selectedProject.project.name,
          projectSlug: projectSlug ?? selectedProject.projectSlug,
          shortId: workItemShortIds.get(workItemId) ?? workItemId,
          orgId: selectedProject.orgId,
          orgName: selectedProject.orgName,
          sourceProject: selectedProject,
        },
      });
    },
    [
      projectSlug,
      selectedProject,
      navigateChatPanel,
      workItemShortIds,
      workItems,
    ]
  );

  const handleDescriptionChange = useCallback((markdown: string) => {
    setProjectDescription(markdown);
  }, []);

  const overviewContent = projectBodyLoading ? (
    <Placeholder
      variant="loading"
      title={t("common:actions.loading")}
      fillParentHeight
    />
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

  const groupedWorkItems = useMemo(
    () => groupWorkItemsForStatusFilter(workItems, "all"),
    [workItems]
  );

  const workItemsContent = workItemsLoading ? (
    <Placeholder
      variant="loading"
      title={t("common:actions.loading")}
      fillParentHeight
    />
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
  ) : (
    <WorkItemsListContent
      groupedWorkItems={groupedWorkItems}
      filteredWorkItems={workItems}
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
  );

  const descriptionContent = (
    <section
      className="flex min-h-0 flex-1 flex-col"
      data-testid="chat-panel-project-section"
    >
      <div className="mb-4 flex shrink-0 items-center justify-start">
        <TabPill
          tabs={panelTabItems}
          activeTab={activePanelTab}
          onChange={(key) => setActivePanelTab(key as ProjectPanelTab)}
          variant="simple"
          fillWidth={false}
          size="chatPanel"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
        {activePanelTab === "overview" ? overviewContent : workItemsContent}
      </div>
    </section>
  );

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="chat-panel-project-detail"
    >
      <DetailPanelContainer className="relative">
        <WorkItemContentStack
          propertiesContent={inlineProperties}
          descriptionContent={descriptionContent}
          descriptionFlexible
        />
        {activePanelTab === "workItems" ? (
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
