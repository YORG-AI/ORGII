/**
 * StickyHeadersContainer Component
 *
 * Generic container for VS Code-style sticky headers with position-based clipping.
 * Each row is absolutely positioned - the last row's position changes
 * as its last child scrolls up, creating a smooth "pushing" effect.
 */
import React, { memo } from "react";

import {
  TREE_GUIDE_OFFSET_BASE,
  TREE_INDENT_GUIDE_CLASS,
  TREE_INDENT_PX,
} from "@src/components/TreeRow";

import type { StickyHeadersContainerProps, TreeNodeBase } from "./types";

const DEFAULT_STICKY_BG = "bg-workstation-bg";

function StickyHeadersContainerInner<TNode extends TreeNodeBase>({
  stickyNodes,
  stickyHeight,
  renderStickyItem,
  onHeaderClick,
  showShadow = true,
  showIndentGuides = false,
  stickyBgClass = DEFAULT_STICKY_BG,
}: StickyHeadersContainerProps<TNode>): React.ReactElement {
  const hasStickyNodes = stickyNodes.length > 0;

  return (
    <div
      className={`absolute top-0 right-0 left-0 z-10 overflow-hidden ${stickyBgClass}`}
      style={{ height: hasStickyNodes ? stickyHeight : 0 }}
    >
      {/* Shadow at bottom of sticky container */}
      {showShadow && hasStickyNodes && (
        <div
          className="pointer-events-none absolute right-0 left-0"
          style={{
            bottom: -3,
            height: 3,
            background:
              "linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, transparent 100%)",
          }}
        />
      )}

      {/* Render each sticky row with absolute positioning */}
      {stickyNodes.map((stickyNode) => (
        <div
          key={stickyNode.node.path}
          className="absolute right-0 left-0"
          style={{
            top: stickyNode.position,
            height: stickyNode.height,
          }}
        >
          <div className="relative h-full">
            {showIndentGuides &&
              stickyNode.depth > 0 &&
              Array.from({ length: stickyNode.depth }, (_, level) => (
                <span
                  key={level}
                  className={TREE_INDENT_GUIDE_CLASS}
                  style={{
                    left: `${TREE_GUIDE_OFFSET_BASE + level * TREE_INDENT_PX}px`,
                  }}
                />
              ))}
            {renderStickyItem(stickyNode, () =>
              onHeaderClick(stickyNode.node.path, stickyNode.node)
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// Memo with generic type support
export const StickyHeadersContainer = memo(
  StickyHeadersContainerInner
) as typeof StickyHeadersContainerInner;
