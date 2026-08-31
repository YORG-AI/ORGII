import React, { memo, useCallback, useMemo } from "react";

import {
  CHEVRON_SIZE,
  TreeRowBase,
  type TreeRowNode,
} from "@src/components/TreeRow";
import { ArrowDown01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";

import { SYMBOL_COLORS, SYMBOL_ICONS } from "./config";
import type { OutlineSymbol } from "./types";

interface SymbolTreeNodeProps {
  symbol: OutlineSymbol;
  depth: number;
  isSelected: boolean;
  onToggle: (symbolId: string) => void;
  onSelect: (symbol: OutlineSymbol) => void;
}

const SymbolTreeNode: React.FC<SymbolTreeNodeProps> = memo(
  ({ symbol, depth, isSelected, onToggle, onSelect }) => {
    const Icon = SYMBOL_ICONS[symbol.kind];
    const colorClass = SYMBOL_COLORS[symbol.kind];
    const hasChildren = symbol.children && symbol.children.length > 0;

    const handleClick = useCallback(() => {
      onSelect(symbol);
      if (hasChildren) {
        onToggle(symbol.id);
      }
    }, [hasChildren, onToggle, onSelect, symbol]);

    const treeNode: TreeRowNode = useMemo(
      () => ({
        id: symbol.id,
        name: symbol.name,
        path: symbol.id,
        type: hasChildren ? "directory" : "file",
        expanded: symbol.expanded,
        icon: hasChildren ? (
          <div className="flex h-4 w-4 items-center justify-center">
            {symbol.expanded ? (
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                data-icon="chevron-down"
                size={CHEVRON_SIZE}
                className="text-text-3"
              />
            ) : (
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={CHEVRON_SIZE}
                className="text-text-3"
              />
            )}
          </div>
        ) : (
          <HugeiconsIcon icon={Icon} size={16} className={colorClass} />
        ),
      }),
      [symbol, hasChildren, colorClass, Icon]
    );

    return (
      <TreeRowBase
        node={treeNode}
        depth={depth}
        isSelected={isSelected}
        onClick={handleClick}
      >
        {hasChildren && (
          <HugeiconsIcon
            icon={Icon}
            size={14}
            className={`flex-shrink-0 ${colorClass}`}
          />
        )}
        <span className="ml-auto flex-shrink-0 text-[11px] text-text-4">
          {symbol.line}
        </span>
      </TreeRowBase>
    );
  }
);

SymbolTreeNode.displayName = "SymbolTreeNode";

export default SymbolTreeNode;
