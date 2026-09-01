import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { usePublishChatPanelHeader } from "@src/engines/ChatPanel/header";
import {
  DashboardSquare01Icon,
  DeliveryBox01Icon,
  HugeiconsIcon,
  KanbanIcon,
  ListIcon,
} from "@src/icons";
import WorkItemContentStack from "@src/modules/ProjectManager/WorkItems/components/WorkItemContentStack";
import ProjectManagerBreadcrumb from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import {
  DetailHeaderTabs,
  DetailPanelContainer,
  DetailTabStrip,
  PersistentDetailTabPanel,
} from "@src/modules/shared/layouts/blocks";
import type { ChatPanelSelectedProject } from "@src/store/ui/chatPanelAtom";

import type { ProjectPanelTab } from "./projectPanel/types";
import { useProjectOverview } from "./projectPanel/useProjectOverview";
import { useProjectProperties } from "./projectPanel/useProjectProperties";
import { useProjectWorkItems } from "./projectPanel/useProjectWorkItems";

interface ProjectPanelViewProps {
  selectedProject: ChatPanelSelectedProject;
}

const PROJECT_PANEL_TABS: ProjectPanelTab[] = ["overview", "list", "kanban"];

export const ProjectPanelView: React.FC<ProjectPanelViewProps> = ({
  selectedProject,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const [activePanelTab, setActivePanelTab] = useState<ProjectPanelTab>("list");
  const panelRef = useRef<HTMLDivElement>(null);
  // All three owners remain mounted for the pane lifetime. Tab bodies retain
  // their existing lazy/sticky mounting below; hiding properties only hides UI.
  const overviewContent = useProjectOverview(selectedProject, t);
  const properties = useProjectProperties(selectedProject, t);
  const workItems = useProjectWorkItems(
    selectedProject,
    activePanelTab,
    panelRef,
    t
  );

  const projectHeaderBreadcrumb = useMemo(
    () => (
      <ProjectManagerBreadcrumb
        segments={[
          ...(selectedProject.orgName
            ? [{ label: selectedProject.orgName }]
            : []),
          {
            label: selectedProject.project.name,
            icon: (
              <HugeiconsIcon
                icon={DeliveryBox01Icon}
                data-icon="box"
                size={HEADER_ICON_SIZE.sm}
                strokeWidth={1.75}
              />
            ),
          },
        ]}
      />
    ),
    [selectedProject.orgName, selectedProject.project.name]
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
            <HugeiconsIcon
              icon={DashboardSquare01Icon}
              data-icon="layout-dashboard"
              size={15}
              strokeWidth={1.8}
            />
          ) : tab === "list" ? (
            <HugeiconsIcon
              icon={ListIcon}
              data-icon="list"
              size={15}
              strokeWidth={1.8}
            />
          ) : (
            <HugeiconsIcon
              icon={KanbanIcon}
              data-icon="kanban"
              size={15}
              strokeWidth={1.8}
            />
          ),
        count: tab === "overview" ? undefined : workItems.count,
      })),
    [t, workItems.count]
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
        {activePanelTab !== "overview" ? workItems.headerControls : null}
        {properties.headerToggle}
      </div>
    ),
    [activePanelTab, properties.headerToggle, workItems.headerControls]
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
        {workItems.listContent}
      </PersistentDetailTabPanel>
      <PersistentDetailTabPanel
        active={activePanelTab === "kanban"}
        id="chat-panel-project-detail-tabpanel-kanban"
        ariaLabelledBy="chat-panel-project-detail-tab-kanban"
        className="flex-col overflow-hidden"
      >
        {workItems.kanbanContent}
      </PersistentDetailTabPanel>
    </section>
  );

  return (
    <div
      ref={panelRef}
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="chat-panel-project-detail"
    >
      {workItems.searchPalette}
      <DetailPanelContainer className="relative">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <WorkItemContentStack
            descriptionContent={descriptionContent}
            descriptionFlexible
            className="min-w-0"
            descriptionClassName="min-h-0 flex flex-1 flex-col"
          />
          {properties.panel}
        </div>
        {activePanelTab !== "overview" ? workItems.footer : null}
      </DetailPanelContainer>
    </div>
  );
};

export default ProjectPanelView;
