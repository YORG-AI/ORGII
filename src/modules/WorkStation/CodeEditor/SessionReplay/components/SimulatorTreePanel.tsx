import { ChevronDown } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";

import { TREE_ROW_HEIGHT, TreeRowBase } from "@src/components/TreeRow";
import type {
  FlattenedTreeNode,
  StickyScrollNode,
} from "@src/components/VirtualizedStickyTree";
import {
  CHEVRON_SIZE,
  STICKY_ROW,
  VirtualizedStickyTree,
  stickyRowPadding,
} from "@src/components/VirtualizedStickyTree";
import { AGENT_DOT_TOKENS } from "@src/engines/Simulator/config";

import { usePrimarySidebarSurface } from "../../../shared/hooks/usePrimarySidebarSurface";
import {
  type FileTreeInput,
  type SimulatorTreeNode,
  buildFileTree,
  flattenFileTree,
} from "../fileTreeUtils";

interface SimulatorTreePanelProps {
  items: FileTreeInput[];
  selectedId: string | null;
  /** Event IDs that should show the agent-selected indicator (blue dot) */
  agentSelectedIds: Set<string>;
  onSelectItem: (eventId: string) => void;
  emptyMessage: string;
  viewMode: "list-tree" | "list";
}

const SimulatorTreePanel: React.FC<SimulatorTreePanelProps> = ({
  items,
  selectedId,
  agentSelectedIds,
  onSelectItem,
  emptyMessage,
  viewMode,
}) => {
  const { stickyBgClass } = usePrimarySidebarSurface();
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());

  const treeItems = useMemo((): FileTreeInput[] => {
    if (viewMode === "list") {
      return items.map((item) => ({
        ...item,
        logicalPath: item.filePath,
        filePath: encodeURIComponent(item.id),
      }));
    }
    return items;
  }, [items, viewMode]);

  const tree = useMemo(() => buildFileTree(treeItems), [treeItems]);
  const flattened = useMemo(
    () => flattenFileTree(tree, collapsedPaths),
    [tree, collapsedPaths]
  );

  const handleNodeClick = useCallback(
    (node: SimulatorTreeNode) => {
      if (node.type === "directory") {
        setCollapsedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(node.path)) next.delete(node.path);
          else next.add(node.path);
          return next;
        });
      } else if (node.eventId) {
        onSelectItem(node.eventId);
      }
    },
    [onSelectItem]
  );

  const renderItem = useCallback(
    (item: FlattenedTreeNode<SimulatorTreeNode>, _index: number) => {
      const isAgentSelected =
        item.node.type === "file" &&
        !!item.node.eventId &&
        agentSelectedIds.has(item.node.eventId);

      return (
        <TreeRowBase
          node={item.node}
          depth={item.depth}
          isSelected={item.node.eventId === selectedId}
          onClick={() => handleNodeClick(item.node)}
          showIndentGuides={false}
          showPathHint={false}
        >
          {item.node.statusLabel && (
            <div
              className={`flex h-5 w-5 flex-shrink-0 items-center justify-center text-[11px] font-bold ${item.node.statusColorClass || "text-text-2"}`}
            >
              {item.node.statusLabel}
            </div>
          )}
          {isAgentSelected && (
            <div className={AGENT_DOT_TOKENS.container}>
              <div className={AGENT_DOT_TOKENS.dot} />
            </div>
          )}
        </TreeRowBase>
      );
    },
    [selectedId, handleNodeClick, agentSelectedIds]
  );

  const renderStickyItem = useCallback(
    (stickyNode: StickyScrollNode<SimulatorTreeNode>, onClick: () => void) => (
      <div
        className={STICKY_ROW.row}
        style={stickyRowPadding(stickyNode.depth)}
        onClick={onClick}
      >
        <div className={STICKY_ROW.chevronBox}>
          <ChevronDown size={CHEVRON_SIZE} className={STICKY_ROW.chevronIcon} />
        </div>
        <span className={STICKY_ROW.name}>{stickyNode.node.name}</span>
      </div>
    ),
    []
  );

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <VirtualizedStickyTree
          flattenedNodes={flattened}
          rowHeight={TREE_ROW_HEIGHT}
          renderItem={renderItem}
          renderStickyItem={renderStickyItem}
          stickyBgClass={stickyBgClass}
          emptyMessage={emptyMessage}
        />
      </div>
    </div>
  );
};

export default SimulatorTreePanel;
