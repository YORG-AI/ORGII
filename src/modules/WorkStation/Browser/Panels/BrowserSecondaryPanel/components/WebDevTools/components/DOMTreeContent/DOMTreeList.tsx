import { useCallback } from "react";
import { Virtuoso } from "react-virtuoso";

import { TREE_ROW_HEIGHT } from "@src/components/TreeRow";

import { DOMTreeNodeRow } from "./DOMTreeNodeRow";
import { useDOMTreeReveal } from "./hooks/useDOMTreeReveal";
import type { FlattenedDOMNode } from "./types";

interface DOMTreeListProps {
  nodes: FlattenedDOMNode[];
  expandedNodes: Set<string>;
  selectedXPath: string | null;
  highlightedXPath?: string | null;
  virtualized: boolean;
  revealXPath?: string | null;
  revealKey?: number;
  onToggle: (xpath: string) => void;
  onSelect: (xpath: string) => void;
  onHover: (xpath: string | null) => void;
}

export function DOMTreeList({
  nodes,
  expandedNodes,
  selectedXPath,
  highlightedXPath,
  virtualized,
  revealXPath,
  revealKey,
  onToggle,
  onSelect,
  onHover,
}: DOMTreeListProps) {
  const { virtuosoRef, scrollContainerRef } = useDOMTreeReveal({
    flattenedNodes: nodes,
    virtualized,
    revealXPath,
    revealKey,
  });
  const renderNode = useCallback(
    (item: FlattenedDOMNode) => (
      <DOMTreeNodeRow
        node={item.node}
        depth={item.depth}
        isExpanded={expandedNodes.has(item.node.xpath)}
        isSelected={item.node.xpath === selectedXPath}
        isHighlighted={item.node.xpath === highlightedXPath}
        hasChildren={item.node.children.length > 0}
        onToggle={onToggle}
        onSelect={onSelect}
        onHover={onHover}
      />
    ),
    [
      expandedNodes,
      highlightedXPath,
      onHover,
      onSelect,
      onToggle,
      selectedXPath,
    ]
  );

  return (
    <div className="h-full overflow-hidden">
      {virtualized ? (
        <Virtuoso
          ref={virtuosoRef}
          totalCount={nodes.length}
          itemContent={(index) => renderNode(nodes[index])}
          computeItemKey={(index) => nodes[index].node.xpath}
          overscan={30}
          increaseViewportBy={{ top: 200, bottom: 200 }}
          className="scrollbar-hide h-full"
          defaultItemHeight={TREE_ROW_HEIGHT}
        />
      ) : (
        <div
          ref={scrollContainerRef}
          className="scrollbar-hide h-full overflow-y-auto py-1"
        >
          {nodes.map((item) => (
            <div key={item.node.xpath} data-xpath={item.node.xpath}>
              {renderNode(item)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
