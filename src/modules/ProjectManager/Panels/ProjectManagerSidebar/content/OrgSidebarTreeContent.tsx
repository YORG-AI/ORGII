import { useAtomValue } from "jotai";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { VirtuosoHandle } from "react-virtuoso";

import {
  STORY_SYNC_ADAPTER,
  syncConnectionsApi,
} from "@src/api/http/integrations";
import { type ProjectOrg, projectApi } from "@src/api/http/project";
import IntegrationIcon from "@src/components/IntegrationIcon";
import { TREE_ROW_HEIGHT, TreeRowBase } from "@src/components/TreeRow";
import {
  type FlattenedTreeNode,
  VirtualizedStickyTree,
} from "@src/components/VirtualizedStickyTree";
import {
  HierarchyCircle01Icon,
  HugeiconsIcon,
  ImportIcon,
  WorkflowCircle05Icon,
} from "@src/icons";
import { cachedLinearProjectsApi } from "@src/modules/ProjectManager/LinearProjects/linearProjectsCache";
import { projectListRefreshAtom } from "@src/store/project/projectAtom";
import {
  PROJECT_ORG_SURFACE_VIEW,
  type ProjectOrgSurfaceView,
  STORY_PERSONAL_ORG_FILTER_ID,
} from "@src/store/workstation/tabs/factories/project";

import type { LinearProjectSelection } from "./WorkspaceTreeContent";
import {
  type LinearTeamOrgRecord,
  type OrgSidebarTreeNode,
  PERSONAL_ORG_ID,
  ROW_ICON_SIZE,
  ROW_ICON_STROKE,
  getErrorMessage,
  getLinearTeamOrgName,
  getLinearTeamOrgNodeId,
  getProjectOrgNodeId,
  isGitFolderSyncedOrg,
  isNativeProjectOrg,
} from "./orgSidebarUtils";

export { WorkspaceOrgTreeContent } from "./WorkspaceOrgTreeContent";

interface ProjectSidebarTreeContentProps {
  onOpenProjects: () => void;
  onOpenWorkItems: () => void;
  onOpenPersonalOrg: (view?: ProjectOrgSurfaceView) => void;
  onOpenProjectOrg: (org: ProjectOrg, view?: ProjectOrgSurfaceView) => void;
  onOpenLinearProjects: (selection?: LinearProjectSelection) => void;
  onOpenLinearWorkItems: (selection?: LinearProjectSelection) => void;
  activeRepoView:
    | "projects"
    | "work-items"
    | "linear-projects"
    | "linear-work-items"
    | "settings"
    | null;
  activeOrgScope?: string | null;
  activeOrgHubId?: string | null;
  activeLinearConnectionId?: string | null;
  activeLinearTeamId?: string | null;
  onImportOrgs: () => void;
}

const ORG_ROW_ICON = (
  <HugeiconsIcon
    icon={HierarchyCircle01Icon}
    data-icon="network"
    size={ROW_ICON_SIZE}
    strokeWidth={ROW_ICON_STROKE}
  />
);

const LINEAR_ORG_ROW_ICON = (
  <IntegrationIcon type="linear" size={ROW_ICON_SIZE} />
);

const IMPORT_ORGS_ROW_ICON = (
  <HugeiconsIcon
    icon={ImportIcon}
    data-icon="import"
    size={ROW_ICON_SIZE}
    strokeWidth={ROW_ICON_STROKE}
  />
);

export const OrgSidebarTreeContent: React.FC<ProjectSidebarTreeContentProps> =
  memo(
    ({
      onOpenPersonalOrg,
      onOpenProjectOrg,
      onOpenLinearProjects,
      onImportOrgs,
      activeRepoView,
      activeOrgHubId = null,
      activeLinearConnectionId = null,
      activeLinearTeamId = null,
    }) => {
      const { t } = useTranslation(["projects", "common"]);
      const refreshSignal = useAtomValue(projectListRefreshAtom);
      const virtuosoRef = useRef<VirtuosoHandle>(null);
      const [projectOrgs, setProjectOrgs] = useState<ProjectOrg[]>([]);
      const [loadingProjectOrgs, setLoadingProjectOrgs] = useState(false);
      const [projectOrgError, setProjectOrgError] = useState<string | null>(
        null
      );
      const [linearTeamOrgs, setLinearTeamOrgs] = useState<
        LinearTeamOrgRecord[]
      >([]);
      const [loadingLinearTeams, setLoadingLinearTeams] = useState(false);
      const [linearTeamError, setLinearTeamError] = useState<string | null>(
        null
      );

      const loadProjectOrgs = useCallback(async () => {
        setLoadingProjectOrgs(true);
        setProjectOrgError(null);
        try {
          const nextProjectOrgs = (await projectApi.readOrgs()).filter(
            isNativeProjectOrg
          );
          setProjectOrgs(nextProjectOrgs);
        } catch (error) {
          setProjectOrgs([]);
          setProjectOrgError(getErrorMessage(error));
        } finally {
          setLoadingProjectOrgs(false);
        }
      }, []);

      const loadLinearTeams = useCallback(async () => {
        setLoadingLinearTeams(true);
        setLinearTeamError(null);
        try {
          const connections = await syncConnectionsApi.list();
          const linearConnections = connections.filter(
            (connection) => connection.adapter_id === STORY_SYNC_ADAPTER.LINEAR
          );
          const teamOrgGroups = await Promise.all(
            linearConnections.map(async (connection) => {
              const teamResult = await cachedLinearProjectsApi.listTeams(
                connection.id
              );
              return teamResult.teams.map(
                (team): LinearTeamOrgRecord => ({
                  connectionId: connection.id,
                  team,
                })
              );
            })
          );
          const nextTeamOrgs = teamOrgGroups.flat();
          setLinearTeamOrgs(nextTeamOrgs);
        } catch (error) {
          setLinearTeamOrgs([]);
          setLinearTeamError(getErrorMessage(error));
        } finally {
          setLoadingLinearTeams(false);
        }
      }, []);

      useEffect(() => {
        void loadProjectOrgs();
        void loadLinearTeams();
      }, [loadProjectOrgs, loadLinearTeams, refreshSignal]);

      const flattenedNodes = useMemo<
        FlattenedTreeNode<OrgSidebarTreeNode>[]
      >(() => {
        const nodes: FlattenedTreeNode<OrgSidebarTreeNode>[] = [
          {
            depth: 0,
            node: {
              id: PERSONAL_ORG_ID,
              name: t("projects:orgs.personalOrg"),
              path: PERSONAL_ORG_ID,
              type: "file",
              icon: ORG_ROW_ICON,
              kind: "personal-org-row",
              orgHubId: STORY_PERSONAL_ORG_FILTER_ID,
            },
          },
        ];

        if (projectOrgError) {
          nodes.push({
            depth: 0,
            node: {
              id: "project-sidebar:org:project:error",
              name: projectOrgError,
              path: "project-sidebar:org:project:error",
              type: "file",
              icon: null,
              isIgnored: true,
              kind: "message",
            },
          });
        }

        for (const org of projectOrgs) {
          const projectOrgNodeId = getProjectOrgNodeId(org.id);
          nodes.push({
            depth: 0,
            node: {
              id: projectOrgNodeId,
              name: org.name,
              path: projectOrgNodeId,
              type: "file",
              icon: ORG_ROW_ICON,
              kind: "project-org-row",
              projectOrg: org,
              orgHubId: org.id,
            },
          });
        }

        if (linearTeamError) {
          nodes.push({
            depth: 0,
            node: {
              id: "project-sidebar:org:linear:error",
              name: linearTeamError,
              path: "project-sidebar:org:linear:error",
              type: "file",
              icon: null,
              isIgnored: true,
              kind: "message",
            },
          });
        } else if (linearTeamOrgs.length === 0 && !loadingLinearTeams) {
          nodes.push({
            depth: 0,
            node: {
              id: "project-sidebar:org:linear:import",
              name: t("projects:orgs.importLinearOrgs"),
              path: "project-sidebar:org:linear:import",
              type: "file",
              icon: IMPORT_ORGS_ROW_ICON,
              kind: "import-orgs-row",
            },
          });
        }

        for (const record of linearTeamOrgs) {
          const linearOrgNodeId = getLinearTeamOrgNodeId(
            record.connectionId,
            record.team.id
          );
          nodes.push({
            depth: 0,
            node: {
              id: linearOrgNodeId,
              name: getLinearTeamOrgName(record.team),
              path: linearOrgNodeId,
              type: "file",
              icon: LINEAR_ORG_ROW_ICON,
              kind: "linear-org-row",
              connectionId: record.connectionId,
              teamId: record.team.id,
              teamName: record.team.name,
            },
          });
        }

        return nodes;
      }, [
        linearTeamError,
        linearTeamOrgs,
        loadingLinearTeams,
        projectOrgError,
        projectOrgs,
        t,
      ]);

      const renderItem = useCallback(
        (item: FlattenedTreeNode<OrgSidebarTreeNode>) => {
          const { node, depth } = item;
          const isActionable =
            node.kind === "personal-org-row" ||
            node.kind === "project-org-row" ||
            node.kind === "linear-org-row" ||
            node.kind === "import-orgs-row";
          const isSelected =
            (node.kind === "personal-org-row" ||
              node.kind === "project-org-row") &&
            node.orgHubId != null &&
            node.orgHubId === activeOrgHubId;
          const isLinearSelected =
            node.kind === "linear-org-row" &&
            ((activeRepoView === "linear-work-items" &&
              node.connectionId === activeLinearConnectionId &&
              node.teamId === activeLinearTeamId) ||
              (activeRepoView === "linear-projects" &&
                node.connectionId === activeLinearConnectionId &&
                node.teamId === activeLinearTeamId));

          const handleClick = isActionable
            ? () => {
                if (node.kind === "personal-org-row") {
                  onOpenPersonalOrg(PROJECT_ORG_SURFACE_VIEW.WORK_ITEMS);
                  return;
                }
                if (node.kind === "project-org-row" && node.projectOrg) {
                  onOpenProjectOrg(
                    node.projectOrg,
                    PROJECT_ORG_SURFACE_VIEW.WORK_ITEMS
                  );
                  return;
                }
                if (node.kind === "linear-org-row") {
                  onOpenLinearProjects(
                    node.connectionId
                      ? {
                          connectionId: node.connectionId,
                          teamId: node.teamId,
                          teamName: node.teamName,
                        }
                      : undefined
                  );
                  return;
                }
                if (node.kind === "import-orgs-row") {
                  onImportOrgs();
                }
              }
            : undefined;

          return (
            <TreeRowBase
              node={node}
              depth={depth}
              isSelected={isSelected || isLinearSelected}
              onClick={handleClick}
              dataPath={node.path}
              className={isActionable ? undefined : "cursor-default"}
            >
              {node.kind === "project-org-row" &&
                isGitFolderSyncedOrg(node.projectOrg) && (
                  <span
                    className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-fill-2 px-1.5 py-0.5 text-[10px] font-medium text-text-3"
                    title={t("projects:orgs.gitFolderSynced")}
                  >
                    <HugeiconsIcon
                      icon={WorkflowCircle05Icon}
                      data-icon="git-branch"
                      size={10}
                      strokeWidth={1.8}
                    />
                    {t("projects:orgs.gitFolderBadge")}
                  </span>
                )}
            </TreeRowBase>
          );
        },
        [
          activeLinearConnectionId,
          activeLinearTeamId,
          activeOrgHubId,
          activeRepoView,
          onImportOrgs,
          onOpenLinearProjects,
          onOpenPersonalOrg,
          onOpenProjectOrg,
          t,
        ]
      );

      return (
        <VirtualizedStickyTree
          flattenedNodes={flattenedNodes}
          rowHeight={TREE_ROW_HEIGHT}
          renderItem={renderItem}
          virtuosoRef={virtuosoRef}
          loading={loadingProjectOrgs || loadingLinearTeams}
          emptyMessage={t("projects:orgs.noLinearOrgs")}
        />
      );
    }
  );

OrgSidebarTreeContent.displayName = "OrgSidebarTreeContent";

export default OrgSidebarTreeContent;
