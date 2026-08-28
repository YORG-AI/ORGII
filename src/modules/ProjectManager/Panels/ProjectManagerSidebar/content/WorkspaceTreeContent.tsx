import React, { memo, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { VirtuosoHandle } from "react-virtuoso";

import {
  TREE_ROW_HEIGHT,
  TreeRowBase,
  type TreeRowNode,
} from "@src/components/TreeRow";
import {
  type FlattenedTreeNode,
  VirtualizedStickyTree,
} from "@src/components/VirtualizedStickyTree";
import {
  BookOpen01Icon,
  BoxIcon,
  HugeiconsIcon,
  ListChecksIcon,
} from "@src/icons";

export interface LinearProjectSelection {
  connectionId: string;
  projectId?: string;
  projectName?: string;
  teamId?: string;
  teamName?: string;
}

interface WorkspaceTreeNode extends TreeRowNode {
  kind:
    | "local-projects"
    | "local-work-items"
    | "linear-projects"
    | "linear-work-items";
}

interface WorkspaceTreeContentProps {
  onOpenProjects: () => void;
  onOpenWorkItems: () => void;
  onOpenLinearProjects: (selection?: LinearProjectSelection) => void;
  onOpenLinearWorkItems: (selection?: LinearProjectSelection) => void;
  activeRepoView:
    | "projects"
    | "work-items"
    | "linear-projects"
    | "linear-work-items"
    | "settings"
    | null;
}

const ROW_ICON_SIZE = 14;
const ROW_ICON_STROKE = 1.75;
const LOCAL_STORIES_ID = "workspace:local-projects";
const LOCAL_WORK_ITEMS_ID = "workspace:local-work-items";
const LINEAR_PROJECTS_ID = "workspace:linear-projects";
const LINEAR_WORK_ITEMS_ID = "workspace:linear-work-items";

export const WorkspaceTreeContent: React.FC<WorkspaceTreeContentProps> = memo(
  ({
    onOpenProjects,
    onOpenWorkItems,
    onOpenLinearProjects,
    onOpenLinearWorkItems,
    activeRepoView,
  }) => {
    const { t } = useTranslation("projects");
    const virtuosoRef = useRef<VirtuosoHandle>(null);

    const flattenedNodes = useMemo<
      FlattenedTreeNode<WorkspaceTreeNode>[]
    >(() => {
      const nodes: FlattenedTreeNode<WorkspaceTreeNode>[] = [
        {
          depth: 0,
          node: {
            id: LOCAL_STORIES_ID,
            name: t("workspace.localProjects"),
            path: LOCAL_STORIES_ID,
            type: "file",
            icon: (
              <HugeiconsIcon
                icon={BookOpen01Icon}
                data-icon="book-open"
                size={ROW_ICON_SIZE}
                strokeWidth={ROW_ICON_STROKE}
              />
            ),
            kind: "local-projects",
          },
        },
        {
          depth: 0,
          node: {
            id: LOCAL_WORK_ITEMS_ID,
            name: t("workspace.localWorkItems"),
            path: LOCAL_WORK_ITEMS_ID,
            type: "file",
            icon: (
              <HugeiconsIcon
                icon={ListChecksIcon}
                data-icon="list-checks"
                size={ROW_ICON_SIZE}
                strokeWidth={ROW_ICON_STROKE}
              />
            ),
            kind: "local-work-items",
          },
        },
        {
          depth: 0,
          node: {
            id: LINEAR_PROJECTS_ID,
            name: t("workspace.linearProjects"),
            path: LINEAR_PROJECTS_ID,
            type: "file",
            icon: (
              <HugeiconsIcon
                icon={BoxIcon}
                data-icon="box"
                size={ROW_ICON_SIZE}
                strokeWidth={ROW_ICON_STROKE}
              />
            ),
            kind: "linear-projects",
          },
        },
        {
          depth: 0,
          node: {
            id: LINEAR_WORK_ITEMS_ID,
            name: t("workspace.linearWorkItems"),
            path: LINEAR_WORK_ITEMS_ID,
            type: "file",
            icon: (
              <HugeiconsIcon
                icon={ListChecksIcon}
                data-icon="list-checks"
                size={ROW_ICON_SIZE}
                strokeWidth={ROW_ICON_STROKE}
              />
            ),
            kind: "linear-work-items",
          },
        },
      ];
      return nodes;
    }, [t]);

    const renderItem = useCallback(
      (item: FlattenedTreeNode<WorkspaceTreeNode>) => {
        const { node, depth } = item;
        const isSelected =
          (node.kind === "local-projects" && activeRepoView === "projects") ||
          (node.kind === "local-work-items" &&
            activeRepoView === "work-items") ||
          (node.kind === "linear-projects" &&
            activeRepoView === "linear-projects") ||
          (node.kind === "linear-work-items" &&
            activeRepoView === "linear-work-items");

        return (
          <TreeRowBase
            node={node}
            depth={depth}
            isSelected={isSelected}
            onClick={() => {
              if (node.kind === "local-projects") {
                onOpenProjects();
                return;
              }
              if (node.kind === "local-work-items") {
                onOpenWorkItems();
                return;
              }
              if (node.kind === "linear-projects") {
                onOpenLinearProjects();
                return;
              }
              onOpenLinearWorkItems();
            }}
            dataPath={node.path}
          />
        );
      },
      [
        activeRepoView,
        onOpenLinearProjects,
        onOpenLinearWorkItems,
        onOpenProjects,
        onOpenWorkItems,
      ]
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

WorkspaceTreeContent.displayName = "WorkspaceTreeContent";
