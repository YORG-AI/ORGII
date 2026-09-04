/**
 * DOMTreeNodeRow Component
 *
 * Renders a single row in the DOM tree with syntax highlighting.
 * Shows: tag name (primary), #id (warning), .classes (text-2)
 */
import React, { memo, useCallback } from "react";

import { TREE_INDENT_PX, TREE_PADDING_X } from "@src/components/TreeRow/config";
import { ArrowDown01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";
import type { DOMTreeNode } from "@src/modules/WorkStation/Browser/hooks/useWebviewDOMTree";

// ============================================
// Types
// ============================================

export interface DOMTreeNodeRowProps {
  /** The DOM node data */
  node: DOMTreeNode;
  /** Depth level for indentation */
  depth: number;
  /** Whether this node is expanded */
  isExpanded: boolean;
  /** Whether this node is selected */
  isSelected: boolean;
  /** Whether this node is highlighted (hover from React) */
  isHighlighted: boolean;
  /** Whether this node has children */
  hasChildren: boolean;
  /** Toggle expanded state */
  onToggle: (xpath: string) => void;
  /** Select this node */
  onSelect: (xpath: string) => void;
  /** Hover this node */
  onHover: (xpath: string | null) => void;
}

// ============================================
// Constants
// ============================================

const CHEVRON_SIZE = 12;

// ============================================
// Component
// ============================================

export const DOMTreeNodeRow: React.FC<DOMTreeNodeRowProps> = memo(
  ({
    node,
    depth,
    isExpanded,
    isSelected,
    isHighlighted,
    hasChildren,
    onToggle,
    onSelect,
    onHover,
  }) => {
    const paddingLeft = depth * TREE_INDENT_PX + TREE_PADDING_X;
    const isPseudo =
      node.nodeKind === "shadow-root" || node.nodeKind === "iframe-document";

    const classes = node.className
      ? node.className.split(" ").filter((cls) => cls.trim())
      : [];

    const handleClick = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        // Pseudo-nodes (shadow-root, iframe-document) have synthetic xpaths
        // that don't resolve in the webview. Toggle expansion instead of
        // attempting selection.
        if (isPseudo) {
          onToggle(node.xpath);
          return;
        }
        onSelect(node.xpath);
      },
      [isPseudo, node.xpath, onSelect, onToggle]
    );

    const handleChevronClick = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        onToggle(node.xpath);
      },
      [node.xpath, onToggle]
    );

    const handleMouseEnter = useCallback(() => {
      if (isPseudo) return;
      onHover(node.xpath);
    }, [isPseudo, node.xpath, onHover]);

    const handleMouseLeave = useCallback(() => {
      if (isPseudo) return;
      onHover(null);
    }, [isPseudo, onHover]);

    const getBgClass = () => {
      if (isSelected) return "bg-primary-1";
      if (isHighlighted) return "bg-fill-2";
      return "";
    };

    if (isPseudo) {
      return (
        <div
          className="group flex cursor-pointer gap-1 border-l-2 border-transparent py-0.5 pr-2 text-xs transition-colors hover:bg-fill-2"
          style={{ paddingLeft }}
          onClick={handleClick}
        >
          <span
            className={`flex h-5 w-4 shrink-0 items-center justify-center rounded ${
              hasChildren ? "cursor-pointer hover:bg-fill-2" : "invisible"
            }`}
            onClick={handleChevronClick}
          >
            {hasChildren &&
              (isExpanded ? (
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
              ))}
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-x-1 leading-relaxed">
            <span className="rounded bg-bg-3 px-1 text-[10px] tracking-wide text-text-3 uppercase">
              {node.nodeKind === "shadow-root" ? "shadow-root" : "iframe"}
            </span>
            <span className="text-text-3 italic">{node.tagName}</span>
          </span>
        </div>
      );
    }

    return (
      <div
        className={`group flex cursor-pointer gap-1 py-0.5 pr-2 text-xs transition-colors ${
          isSelected ? "" : "hover:bg-fill-2"
        } ${getBgClass()} ${
          isSelected
            ? "border-l-2 border-primary-6"
            : "border-l-2 border-transparent"
        }`}
        style={{ paddingLeft }}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <span
          className={`flex h-5 w-4 shrink-0 items-center justify-center rounded ${
            hasChildren ? "cursor-pointer hover:bg-fill-2" : "invisible"
          }`}
          onClick={handleChevronClick}
        >
          {hasChildren &&
            (isExpanded ? (
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
            ))}
        </span>

        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-0.5 leading-relaxed">
          <span className="text-text-3">&lt;</span>
          <span className="text-primary-6">{node.tagName}</span>
          {node.id && (
            <span className="text-warning-6">
              <span className="text-text-4">#</span>
              {node.id}
            </span>
          )}
          {classes.map((className, index) => (
            <span key={index} className="text-text-2">
              <span className="text-text-4">.</span>
              {className}
            </span>
          ))}
          <span className="text-text-3">&gt;</span>
          {node.rect.width > 0 && node.rect.height > 0 && (
            <span className="ml-1 rounded bg-bg-3 px-1 text-[10px] text-text-3">
              {node.rect.width}×{node.rect.height}
            </span>
          )}
        </span>
      </div>
    );
  }
);

DOMTreeNodeRow.displayName = "DOMTreeNodeRow";

export default DOMTreeNodeRow;
