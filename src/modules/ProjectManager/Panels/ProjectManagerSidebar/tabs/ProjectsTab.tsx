/**
 * ProjectsTab Configuration
 */
import {
  Box,
  FolderKanban,
  Github,
  Import,
  ListChecks,
  Plus,
  RefreshCw,
  Settings,
  SquarePen,
} from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { ProjectOrg } from "@src/api/http/project";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import type { SectionHeaderAction } from "@src/components/TreePanelSidebar/types";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  HEADER_BUTTON,
  HEADER_ICON_SIZE,
  type PrimarySidebarTab,
} from "@src/modules/WorkStation/shared";
import type { ProjectOrgSurfaceView } from "@src/store/workstation/tabs";

import OrgSidebarTreeContent, {
  WorkspaceOrgTreeContent,
} from "../content/OrgSidebarTreeContent";
import type { LinearProjectSelection } from "../content/WorkspaceTreeContent";

const ACTION_ICON_SIZE = DROPDOWN_ITEM.iconSize;
const ACTION_ICON_STROKE = 1.75;
const TAB_ICON_SIZE = 16;

interface CreateActionsDropdownProps {
  onCreateProject: () => void;
  onCreateWorkItem: () => void;
  onImportGithubIssuesProject: () => void;
  onOpenChange: (open: boolean) => void;
  createLabel: string;
  createProjectLabel: string;
  createWorkItemLabel: string;
  importGithubIssuesProjectLabel: string;
}

interface OrgActionsDropdownProps {
  onCreateOrg: () => void;
  onImportOrgs: () => void;
  onOpenChange: (open: boolean) => void;
  addOrgLabel: string;
  importOrgsLabel: string;
}

const OrgActionsDropdown: React.FC<OrgActionsDropdownProps> = ({
  onCreateOrg,
  onImportOrgs,
  onOpenChange,
  addOrgLabel,
  importOrgsLabel,
}) => {
  const {
    isOpen,
    isPositioned,
    toggle,
    close,
    triggerRef,
    panelRef,
    panelPosition,
  } = useDropdownEngine<HTMLButtonElement>({
    gap: DROPDOWN_PANEL.triggerGapTight,
    align: "right",
    closeOnEsc: true,
    placement: "bottom",
    onOpenChange,
  });

  const handleAddOrg = useCallback(() => {
    close();
    onCreateOrg();
  }, [close, onCreateOrg]);

  const handleImportOrgs = useCallback(() => {
    close();
    onImportOrgs();
  }, [close, onImportOrgs]);

  return (
    <>
      <button
        ref={triggerRef}
        className={`${HEADER_BUTTON.actionTreeRow} ${isOpen ? "!bg-surface-selected !text-primary-6" : ""}`}
        data-dropdown-open={isOpen}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
        title={addOrgLabel}
        type="button"
      >
        <Plus size={HEADER_ICON_SIZE.md} />
      </button>
      {isOpen &&
        isPositioned &&
        createPortal(
          <div
            ref={panelRef}
            className={`${DROPDOWN_CLASSES.menuPanelBase} fixed ${DROPDOWN_WIDTHS.sidebarMenuClass}`}
            style={{
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              left:
                panelPosition.right === undefined
                  ? panelPosition.left
                  : undefined,
              right: panelPosition.right,
            }}
            role="menu"
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
          >
            <button
              type="button"
              onClick={handleAddOrg}
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
              role="menuitem"
            >
              <Plus
                size={ACTION_ICON_SIZE}
                strokeWidth={ACTION_ICON_STROKE}
                className="text-text-2"
              />
              <span className="min-w-0 flex-1 truncate">{addOrgLabel}</span>
            </button>
            <button
              type="button"
              onClick={handleImportOrgs}
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
              role="menuitem"
            >
              <Import
                size={ACTION_ICON_SIZE}
                strokeWidth={ACTION_ICON_STROKE}
                className="text-text-2"
              />
              <span className="min-w-0 flex-1 truncate">{importOrgsLabel}</span>
            </button>
          </div>,
          document.body
        )}
    </>
  );
};

const CreateActionsDropdown: React.FC<CreateActionsDropdownProps> = ({
  onCreateProject,
  onCreateWorkItem,
  onImportGithubIssuesProject,
  onOpenChange,
  createLabel,
  createProjectLabel,
  createWorkItemLabel,
  importGithubIssuesProjectLabel,
}) => {
  const {
    isOpen,
    isPositioned,
    toggle,
    close,
    triggerRef,
    panelRef,
    panelPosition,
  } = useDropdownEngine<HTMLButtonElement>({
    gap: DROPDOWN_PANEL.triggerGapTight,
    align: "right",
    closeOnEsc: true,
    placement: "bottom",
    onOpenChange,
  });

  const handleCreateWorkItem = useCallback(() => {
    close();
    onCreateWorkItem();
  }, [close, onCreateWorkItem]);

  const handleCreateProject = useCallback(() => {
    close();
    onCreateProject();
  }, [close, onCreateProject]);

  const handleImportGithubIssuesProject = useCallback(() => {
    close();
    onImportGithubIssuesProject();
  }, [close, onImportGithubIssuesProject]);

  return (
    <>
      <button
        ref={triggerRef}
        className={`${HEADER_BUTTON.actionTreeRow} ${isOpen ? "!bg-surface-selected !text-primary-6" : ""}`}
        data-dropdown-open={isOpen}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
        title={createLabel}
        type="button"
      >
        <Plus size={HEADER_ICON_SIZE.md} />
      </button>
      {isOpen &&
        isPositioned &&
        createPortal(
          <div
            ref={panelRef}
            className={`${DROPDOWN_CLASSES.menuPanelBase} fixed ${DROPDOWN_WIDTHS.sidebarMenuClass}`}
            style={{
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              left:
                panelPosition.right === undefined
                  ? panelPosition.left
                  : undefined,
              right: panelPosition.right,
            }}
            role="menu"
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
          >
            <button
              type="button"
              onClick={handleCreateWorkItem}
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
              role="menuitem"
            >
              <ListChecks
                size={ACTION_ICON_SIZE}
                strokeWidth={ACTION_ICON_STROKE}
                className="text-text-2"
              />
              <span className="min-w-0 flex-1 truncate">
                {createWorkItemLabel}
              </span>
            </button>
            <button
              type="button"
              onClick={handleCreateProject}
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
              role="menuitem"
            >
              <Box
                size={ACTION_ICON_SIZE}
                strokeWidth={ACTION_ICON_STROKE}
                className="text-text-2"
              />
              <span className="min-w-0 flex-1 truncate">
                {createProjectLabel}
              </span>
            </button>
            <button
              type="button"
              onClick={handleImportGithubIssuesProject}
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
              role="menuitem"
            >
              <Github
                size={ACTION_ICON_SIZE}
                strokeWidth={ACTION_ICON_STROKE}
                className="text-text-2"
              />
              <span className="min-w-0 flex-1 truncate">
                {importGithubIssuesProjectLabel}
              </span>
            </button>
          </div>,
          document.body
        )}
    </>
  );
};

export interface UseProjectsTabConfigProps {
  loading: boolean;
  onCreateProject: () => void;
  onCreateWorkItem: () => void;
  onImportGithubIssuesProject: () => void;
  onCreateOrg: () => void;
  onImportOrgs: () => void;
  onOpenProjects: () => void;
  onOpenWorkItems: () => void;
  onOpenProjectTree?: () => void;
  onOpenProjectJourney?: () => void;
  onOpenPersonalOrg: (view?: ProjectOrgSurfaceView) => void;
  onOpenProjectOrg: (org: ProjectOrg, view?: ProjectOrgSurfaceView) => void;
  onOpenLinearProjects: (selection?: LinearProjectSelection) => void;
  onOpenLinearWorkItems: (selection?: LinearProjectSelection) => void;
  onOpenSettings: () => void;
  activeOrgScope: string | null;
  activeOrgHubId: string | null;
  activeLinearConnectionId: string | null;
  activeLinearTeamId: string | null;
  activeRepoView:
    | "projects"
    | "work-items"
    | "project-tree"
    | "project-journey"
    | "linear-projects"
    | "linear-work-items"
    | "settings"
    | null;
  onRefresh: () => void;
}

export function useProjectsTabConfig({
  loading,
  onCreateProject,
  onCreateWorkItem,
  onImportGithubIssuesProject,
  onCreateOrg,
  onImportOrgs,
  onOpenProjects,
  onOpenWorkItems,
  onOpenProjectTree,
  onOpenProjectJourney,
  onOpenPersonalOrg,
  onOpenProjectOrg,
  onOpenLinearProjects,
  onOpenLinearWorkItems,
  onOpenSettings,
  activeOrgScope,
  activeOrgHubId,
  activeLinearConnectionId,
  activeLinearTeamId,
  activeRepoView,
  onRefresh,
}: UseProjectsTabConfigProps): PrimarySidebarTab {
  const { t } = useTranslation(["navigation", "projects", "common"]);
  const { spinClass: refreshSpinClass, handleClick: handleRefreshClick } =
    useRefreshSpin(onRefresh, loading);
  const [createDropdownOpen, setCreateDropdownOpen] = useState(false);
  const [orgDropdownOpen, setOrgDropdownOpen] = useState(false);

  const projectsActions = useMemo<SectionHeaderAction[]>(
    () => [
      {
        key: "create-project",
        icon: <Box size={ACTION_ICON_SIZE} strokeWidth={ACTION_ICON_STROKE} />,
        tooltip: t("projects:projects.createProject"),
        onClick: onCreateProject,
      },
      {
        key: "create-work-item",
        icon: (
          <SquarePen size={ACTION_ICON_SIZE} strokeWidth={ACTION_ICON_STROKE} />
        ),
        tooltip: t("projects:workItems.createWorkItem"),
        onClick: onCreateWorkItem,
      },
      {
        key: "create",
        customRender: (
          <CreateActionsDropdown
            onCreateProject={onCreateProject}
            onCreateWorkItem={onCreateWorkItem}
            onImportGithubIssuesProject={onImportGithubIssuesProject}
            onOpenChange={setCreateDropdownOpen}
            createLabel={t("common:actions.create")}
            createProjectLabel={t("projects:projects.createProject")}
            createWorkItemLabel={t("projects:workItems.createWorkItem")}
            importGithubIssuesProjectLabel={t(
              "projects:githubIssuesImport.menuLabel"
            )}
          />
        ),
        forceVisible: createDropdownOpen,
      },
      {
        key: "refresh",
        icon: (
          <RefreshCw
            size={ACTION_ICON_SIZE}
            strokeWidth={ACTION_ICON_STROKE}
            className={refreshSpinClass}
          />
        ),
        tooltip: t("common:actions.refresh"),
        onClick: handleRefreshClick,
      },
      {
        key: "settings",
        icon: (
          <Settings size={ACTION_ICON_SIZE} strokeWidth={ACTION_ICON_STROKE} />
        ),
        tooltip: t("common:tabs.settings"),
        onClick: onOpenSettings,
      },
    ],
    [
      t,
      createDropdownOpen,
      refreshSpinClass,
      handleRefreshClick,
      onCreateProject,
      onCreateWorkItem,
      onImportGithubIssuesProject,
      onOpenSettings,
    ]
  );

  const orgActions = useMemo<SectionHeaderAction[]>(
    () => [
      {
        key: "create-org",
        customRender: (
          <OrgActionsDropdown
            onCreateOrg={onCreateOrg}
            onImportOrgs={onImportOrgs}
            onOpenChange={setOrgDropdownOpen}
            addOrgLabel={t("projects:orgs.addOrg")}
            importOrgsLabel={t("projects:orgs.importLinearOrgs")}
          />
        ),
        forceVisible: orgDropdownOpen,
      },
    ],
    [onCreateOrg, onImportOrgs, orgDropdownOpen, t]
  );

  return useMemo(
    () => ({
      key: "projects",
      label: t("labels.projects"),
      icon: <FolderKanban size={TAB_ICON_SIZE} />,
      sections: [
        {
          key: "workspace",
          title: t("projects:workspace.title"),
          content: (
            <WorkspaceOrgTreeContent
              onOpenProjects={onOpenProjects}
              onOpenWorkItems={onOpenWorkItems}
              onOpenProjectTree={onOpenProjectTree}
              onOpenProjectJourney={onOpenProjectJourney}
              activeRepoView={activeRepoView}
              activeOrgScope={activeOrgScope}
            />
          ),
          defaultFlexGrow: 0.35,
          resizable: false,
          actions: projectsActions,
        },
        {
          key: "orgs",
          title: t("projects:orgs.yourOrgs"),
          content: (
            <OrgSidebarTreeContent
              onOpenProjects={onOpenProjects}
              onOpenWorkItems={onOpenWorkItems}
              onOpenPersonalOrg={onOpenPersonalOrg}
              onOpenProjectOrg={onOpenProjectOrg}
              onOpenLinearProjects={onOpenLinearProjects}
              onOpenLinearWorkItems={onOpenLinearWorkItems}
              onImportOrgs={onImportOrgs}
              activeRepoView={activeRepoView}
              activeOrgHubId={activeOrgHubId}
              activeLinearConnectionId={activeLinearConnectionId}
              activeLinearTeamId={activeLinearTeamId}
            />
          ),
          defaultFlexGrow: 1,
          resizable: false,
          actions: orgActions,
        },
      ],
    }),
    [
      t,
      onOpenProjects,
      activeRepoView,
      activeOrgScope,
      activeOrgHubId,
      activeLinearConnectionId,
      activeLinearTeamId,
      projectsActions,
      orgActions,
      onOpenWorkItems,
      onOpenProjectTree,
      onOpenProjectJourney,
      onOpenPersonalOrg,
      onOpenProjectOrg,
      onOpenLinearProjects,
      onOpenLinearWorkItems,
      onImportOrgs,
    ]
  );
}
