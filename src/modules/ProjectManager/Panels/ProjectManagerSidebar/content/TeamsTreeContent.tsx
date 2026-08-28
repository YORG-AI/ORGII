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
  linearProjectsApi,
  syncConnectionsApi,
} from "@src/api/http/integrations";
import type {
  LinearTeamSummary,
  SyncConnection,
} from "@src/api/http/integrations";
import {
  TREE_ROW_HEIGHT,
  TreeRowBase,
  type TreeRowNode,
} from "@src/components/TreeRow";
import {
  type FlattenedTreeNode,
  VirtualizedStickyTree,
} from "@src/components/VirtualizedStickyTree";
import { Building02Icon, HugeiconsIcon, UserMultipleIcon } from "@src/icons";

interface LinearConnectionTeams {
  connection: SyncConnection;
  teams: LinearTeamSummary[];
  error: string | null;
}

interface TeamsTreeNode extends TreeRowNode {
  kind:
    | "local-teams-root"
    | "local-team"
    | "linear-teams-root"
    | "linear-team"
    | "message";
  connectionId?: string;
  teamId?: string;
}

interface TeamsTreeContentProps {
  refreshSignal: number;
}

const ROW_ICON_SIZE = 14;
const ROW_ICON_STROKE = 1.75;
const LOCAL_TEAMS_ROOT_ID = "teams:local";
const LINEAR_TEAMS_ROOT_ID = "teams:linear";
const DEFAULT_LOCAL_TEAMS = [
  { id: "local-team:personal-org", labelKey: "teams.personalOrg" },
  { id: "local-team:agent-orgs", labelKey: "teams.agentOrgs" },
] as const;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const TeamsTreeContent: React.FC<TeamsTreeContentProps> = memo(
  ({ refreshSignal }) => {
    const { t } = useTranslation(["projects", "common"]);
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const [linearRecords, setLinearRecords] = useState<LinearConnectionTeams[]>(
      []
    );
    const [loadingLinearTeams, setLoadingLinearTeams] = useState(false);
    const [topError, setTopError] = useState<string | null>(null);
    const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(
      () => new Set([LOCAL_TEAMS_ROOT_ID, LINEAR_TEAMS_ROOT_ID])
    );

    const toggleExpanded = useCallback((nodeId: string) => {
      setExpandedNodeIds((current) => {
        const next = new Set(current);
        if (next.has(nodeId)) {
          next.delete(nodeId);
        } else {
          next.add(nodeId);
        }
        return next;
      });
    }, []);

    const loadLinearTeams = useCallback(async () => {
      setLoadingLinearTeams(true);
      setTopError(null);
      try {
        const connections = await syncConnectionsApi.list();
        const linearConnections = connections.filter(
          (connection) => connection.adapter_id === STORY_SYNC_ADAPTER.LINEAR
        );
        const nextRecords = await Promise.all(
          linearConnections.map(
            async (connection): Promise<LinearConnectionTeams> => {
              try {
                const teamResult = await linearProjectsApi.listTeams(
                  connection.id
                );
                return {
                  connection,
                  teams: teamResult.teams,
                  error: null,
                };
              } catch (error) {
                return {
                  connection,
                  teams: [],
                  error: getErrorMessage(error),
                };
              }
            }
          )
        );
        setLinearRecords(nextRecords);
      } catch (error) {
        setLinearRecords([]);
        setTopError(getErrorMessage(error));
      } finally {
        setLoadingLinearTeams(false);
      }
    }, []);

    useEffect(() => {
      void loadLinearTeams();
    }, [loadLinearTeams, refreshSignal]);

    const flattenedNodes = useMemo<FlattenedTreeNode<TeamsTreeNode>[]>(() => {
      const nodes: FlattenedTreeNode<TeamsTreeNode>[] = [];
      const localTeamsExpanded = expandedNodeIds.has(LOCAL_TEAMS_ROOT_ID);
      const linearTeamsExpanded = expandedNodeIds.has(LINEAR_TEAMS_ROOT_ID);

      nodes.push({
        depth: 0,
        node: {
          id: LOCAL_TEAMS_ROOT_ID,
          name: t("projects:teams.localTeams"),
          path: LOCAL_TEAMS_ROOT_ID,
          type: "directory",
          expanded: localTeamsExpanded,
          icon: (
            <HugeiconsIcon
              icon={UserMultipleIcon}
              data-icon="users"
              size={ROW_ICON_SIZE}
              strokeWidth={ROW_ICON_STROKE}
            />
          ),
          kind: "local-teams-root",
        },
      });

      if (localTeamsExpanded) {
        for (const team of DEFAULT_LOCAL_TEAMS) {
          nodes.push({
            depth: 1,
            node: {
              id: team.id,
              name: t(`projects:${team.labelKey}`),
              path: team.id,
              type: "file",
              icon: (
                <HugeiconsIcon
                  icon={Building02Icon}
                  data-icon="building-2"
                  size={ROW_ICON_SIZE}
                  strokeWidth={ROW_ICON_STROKE}
                />
              ),
              kind: "local-team",
            },
          });
        }
      }

      nodes.push({
        depth: 0,
        node: {
          id: LINEAR_TEAMS_ROOT_ID,
          name: t("projects:teams.linearTeams"),
          path: LINEAR_TEAMS_ROOT_ID,
          type: "directory",
          expanded: linearTeamsExpanded,
          icon: (
            <HugeiconsIcon
              icon={UserMultipleIcon}
              data-icon="users"
              size={ROW_ICON_SIZE}
              strokeWidth={ROW_ICON_STROKE}
            />
          ),
          kind: "linear-teams-root",
        },
      });

      if (linearTeamsExpanded) {
        if (topError) {
          nodes.push({
            depth: 1,
            node: {
              id: "teams:linear:error",
              name: topError,
              path: "teams:linear:error",
              type: "file",
              icon: null,
              kind: "message",
            },
          });
        } else if (linearRecords.length === 0 && !loadingLinearTeams) {
          nodes.push({
            depth: 1,
            node: {
              id: "teams:linear:empty",
              name: t("projects:linearProjects.emptyConnections.title"),
              path: "teams:linear:empty",
              type: "file",
              icon: null,
              kind: "message",
            },
          });
        }

        let hasTeam = false;
        for (const record of linearRecords) {
          if (record.error) {
            nodes.push({
              depth: 1,
              node: {
                id: `teams:linear:${record.connection.id}:error`,
                name: record.error,
                path: `teams:linear:${record.connection.id}:error`,
                type: "file",
                icon: null,
                kind: "message",
                connectionId: record.connection.id,
              },
            });
            continue;
          }
          for (const team of record.teams) {
            hasTeam = true;
            nodes.push({
              depth: 1,
              node: {
                id: `teams:linear:${record.connection.id}:${team.id}`,
                name: team.name,
                path: `teams:linear:${record.connection.id}:${team.id}`,
                type: "file",
                icon: (
                  <HugeiconsIcon
                    icon={Building02Icon}
                    data-icon="building-2"
                    size={ROW_ICON_SIZE}
                    strokeWidth={ROW_ICON_STROKE}
                  />
                ),
                kind: "linear-team",
                connectionId: record.connection.id,
                teamId: team.id,
              },
            });
          }
        }

        if (!hasTeam && linearRecords.length > 0 && !loadingLinearTeams) {
          nodes.push({
            depth: 1,
            node: {
              id: "teams:linear:empty-teams",
              name: t("projects:teams.emptyLinearTeams"),
              path: "teams:linear:empty-teams",
              type: "file",
              icon: null,
              kind: "message",
            },
          });
        }
      }

      return nodes;
    }, [expandedNodeIds, linearRecords, loadingLinearTeams, t, topError]);

    const renderItem = useCallback(
      (item: FlattenedTreeNode<TeamsTreeNode>) => {
        const { node, depth } = item;
        const isExpandable =
          node.kind === "local-teams-root" || node.kind === "linear-teams-root";

        if (node.kind === "message") {
          return (
            <TreeRowBase
              node={node}
              depth={depth}
              isSelected={false}
              dataPath={node.path}
              className="cursor-default text-text-4"
            />
          );
        }

        return (
          <TreeRowBase
            node={node}
            depth={depth}
            isSelected={false}
            onClick={isExpandable ? () => toggleExpanded(node.id) : undefined}
            dataPath={node.path}
          />
        );
      },
      [toggleExpanded]
    );

    return (
      <VirtualizedStickyTree
        flattenedNodes={flattenedNodes}
        rowHeight={TREE_ROW_HEIGHT}
        renderItem={renderItem}
        virtuosoRef={virtuosoRef}
        loading={loadingLinearTeams}
        emptyMessage={t("projects:teams.empty")}
      />
    );
  }
);

TeamsTreeContent.displayName = "TeamsTreeContent";
