/**
 * CollapseRow Component
 *
 * Displays a collapsed section placeholder that can be expanded
 */
import React from "react";

import {
  ArrowDownFromLineIcon,
  ArrowUpFromLineIcon,
  FoldVerticalIcon,
  HugeiconsIcon,
} from "@src/icons";

import type { CollapsedSection } from "../types";

interface CollapseRowProps {
  collapsedSection: CollapsedSection;
  onExpand: () => void;
  cherrypicking?: boolean;
}

export const CollapseRow: React.FC<CollapseRowProps> = ({
  collapsedSection,
  onExpand,
  cherrypicking,
}) => {
  // Determine icon based on collapse position
  const CollapseIcon =
    collapsedSection.collapsePosition === "start"
      ? ArrowUpFromLineIcon
      : collapsedSection.collapsePosition === "end"
        ? ArrowDownFromLineIcon
        : FoldVerticalIcon;

  return (
    <div className="split-row split-row-collapse" onClick={onExpand}>
      {/* Left pane */}
      <div className="split-row-pane split-row-pane-left split-row-context">
        <div className="split-row-content collapse-placeholder" />
      </div>

      {/* Center gutter */}
      <div className="split-row-center">
        <div className="split-row-gutter split-row-gutter-old">
          <HugeiconsIcon
            icon={CollapseIcon}
            size={14}
            className="collapse-icon"
          />
        </div>

        {cherrypicking && (
          <>
            <div className="split-row-cherrypick split-row-cherrypick-left" />
            <div className="split-row-multiselect cherry-pick-multi-context" />
            <div className="split-row-cherrypick split-row-cherrypick-right" />
          </>
        )}

        <div className="split-row-gutter split-row-gutter-new collapse-label">
          {collapsedSection.collapsedCount} unchanged lines
        </div>
      </div>

      {/* Right pane */}
      <div className="split-row-pane split-row-pane-right split-row-context">
        <div className="split-row-content collapse-placeholder" />
      </div>
    </div>
  );
};
