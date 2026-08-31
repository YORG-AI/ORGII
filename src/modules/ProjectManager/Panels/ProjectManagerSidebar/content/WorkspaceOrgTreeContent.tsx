/**
 * WorkspaceOrgTreeContent
 *
 * Tree content component for the "All Workspaces" view in the ProjectManager
 * sidebar. Renders top-level workspace entries (Work Items, Projects, Views).
 *
 * Extracted from OrgSidebarTreeContent.tsx to reduce file size.
 */
import React, { memo, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { VirtuosoHandle } from "react-virtuoso";

import { TREE_ROW_HEIGHT, TreeRowBase } from "@src/components/TreeRow";
import {
  type FlattenedTreeNode,
  VirtualizedStickyTree,
} from "@src/components/VirtualizedStickyTree";
import {
  DeliveryBox01Icon,
  HugeiconsIcon,
  Layers01Icon,
  ListChecksIcon,
  MoreHorizontalIcon,
} from "@src/icons";
import { STORY_ORG_SCOPE } from "@src/store/workstation/tabs/factories/project";

import {
  ROW_ICON_SIZE,
  ROW_ICON_STROKE,
  type WorkspaceTreeNode,
} from "./orgSidebarUtils";

interface WorkspaceOrgTreeContentProps {
  onOpenProjects: () => void;
  onOpenWorkItems: () => void;
  activeRepoView:
    | "projects"
    | "work-items"
    | "linear-projects"
    | "linear-work-items"
    | "settings"
    | null;
  activeOrgScope?: string | null;
}

export const WorkspaceOrgTreeContent: React.FC<WorkspaceOrgTreeContentProps> =
  memo(
    ({ onOpenProjects, onOpenWorkItems, activeRepoView, activeOrgScope }) => {
      const { t } = useTranslation("projects");
      const virtuosoRef = useRef<VirtuosoHandle>(null);

      const flattenedNodes = useMemo<FlattenedTreeNode<WorkspaceTreeNode>[]>(
        () => [
          {
            depth: 0,
            node: {
              id: "project-sidebar:workspace:work-items",
              name: t("workspace.workItems"),
              path: "project-sidebar:workspace:work-items",
              type: "file",
              icon: (
                <HugeiconsIcon
                  icon={ListChecksIcon}
                  data-icon="list-checks"
                  size={ROW_ICON_SIZE}
                  strokeWidth={ROW_ICON_STROKE}
                />
              ),
              kind: "workspace-work-items",
            },
          },
          {
            depth: 0,
            node: {
              id: "project-sidebar:workspace:projects",
              name: t("workspace.projects"),
              path: "project-sidebar:workspace:projects",
              type: "file",
              icon: (
                <HugeiconsIcon
                  icon={DeliveryBox01Icon}
                  data-icon="box"
                  size={ROW_ICON_SIZE}
                  strokeWidth={ROW_ICON_STROKE}
                />
              ),
              kind: "workspace-projects",
            },
          },
          {
            depth: 0,
            node: {
              id: "project-sidebar:workspace:views",
              name: t("workspace.views"),
              path: "project-sidebar:workspace:views",
              type: "file",
              icon: (
                <HugeiconsIcon
                  icon={Layers01Icon}
                  data-icon="layers"
                  size={ROW_ICON_SIZE}
                  strokeWidth={ROW_ICON_STROKE}
                />
              ),
              isIgnored: true,
              kind: "workspace-views",
            },
          },
          {
            depth: 0,
            node: {
              id: "project-sidebar:workspace:more",
              name: t("workspace.more"),
              path: "project-sidebar:workspace:more",
              type: "file",
              icon: (
                <HugeiconsIcon
                  icon={MoreHorizontalIcon}
                  data-icon="ellipsis"
                  size={ROW_ICON_SIZE}
                  strokeWidth={ROW_ICON_STROKE}
                />
              ),
              isIgnored: true,
              kind: "workspace-more",
            },
          },
        ],
        [t]
      );

      const renderItem = useCallback(
        (item: FlattenedTreeNode<WorkspaceTreeNode>) => {
          const { node, depth } = item;
          const isWorkspaceScope = activeOrgScope === STORY_ORG_SCOPE.ALL;
          const isSelected =
            (node.kind === "workspace-projects" &&
              activeRepoView === "projects" &&
              isWorkspaceScope) ||
            (node.kind === "workspace-work-items" &&
              activeRepoView === "work-items" &&
              isWorkspaceScope);
          const isActionable =
            node.kind === "workspace-projects" ||
            node.kind === "workspace-work-items";
          const handleClick =
            node.kind === "workspace-projects"
              ? onOpenProjects
              : node.kind === "workspace-work-items"
                ? onOpenWorkItems
                : undefined;

          return (
            <TreeRowBase
              node={node}
              depth={depth}
              isSelected={isSelected}
              onClick={handleClick}
              dataPath={node.path}
              className={isActionable ? undefined : "cursor-default"}
            />
          );
        },
        [activeOrgScope, activeRepoView, onOpenProjects, onOpenWorkItems]
      );

      return (
        <VirtualizedStickyTree
          flattenedNodes={flattenedNodes}
          rowHeight={TREE_ROW_HEIGHT}
          renderItem={renderItem}
          virtuosoRef={virtuosoRef}
          emptyMessage={t("workspace.empty")}
        />
      );
    }
  );

WorkspaceOrgTreeContent.displayName = "WorkspaceOrgTreeContent";
