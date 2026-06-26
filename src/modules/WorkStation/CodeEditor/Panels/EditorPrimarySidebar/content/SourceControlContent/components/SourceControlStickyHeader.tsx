/**
 * SourceControlStickyHeader
 *
 * Renders the sticky scroll header rows used by VirtualizedStickyTree inside
 * SourceControlContent. Handles two distinct node types:
 *
 *  - "section-header": top-level section row (Merge Changes / Staged / Changes)
 *    with a count badge and optional warning colour.
 *  - "directory" / file: collapsed/expanded folder row (same sticky behaviour,
 *    different icon and badge).
 *
 * Extracted from SourceControlContent to keep that component under the
 * line limit.
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { GitStatusBadge, type GitStatusInfo } from "@src/components/TreeRow";
import type { StickyScrollNode } from "@src/components/VirtualizedStickyTree";
import {
  CHEVRON_SIZE,
  STICKY_ROW,
  stickyRowPadding,
} from "@src/components/VirtualizedStickyTree";
import {
  COUNT_BADGE,
  getCountBadgeSizeClass,
} from "@src/modules/WorkStation/shared/tokens";

import type { SourceControlNode } from "../utils/virtualizedTreeUtils";

interface SourceControlStickyHeaderProps {
  stickyNode: StickyScrollNode<SourceControlNode>;
  onClick: () => void;
  stickyBgClass?: string;
}

export const SourceControlStickyHeader: React.FC<
  SourceControlStickyHeaderProps
> = ({ stickyNode, onClick, stickyBgClass }) => {
  const { t } = useTranslation();
  const { node, depth } = stickyNode;
  const stickyRowClass = stickyBgClass
    ? `${STICKY_ROW.rowBase} ${stickyBgClass}`
    : STICKY_ROW.row;

  if (node.nodeType === "section-header") {
    const isWarning = node.variant === "warning";
    const sectionCount = node.count ?? 0;
    const countBadgeVariant = isWarning
      ? COUNT_BADGE.danger
      : sectionCount === 0
        ? COUNT_BADGE.muted
        : COUNT_BADGE.primary;
    return (
      <div
        className={stickyRowClass}
        style={stickyRowPadding(depth)}
        onClick={onClick}
      >
        <div className={STICKY_ROW.chevronBox}>
          {node.expanded ? (
            <ChevronDown
              size={CHEVRON_SIZE}
              className={STICKY_ROW.chevronIcon}
            />
          ) : (
            <ChevronRight
              size={CHEVRON_SIZE}
              className={STICKY_ROW.chevronIcon}
            />
          )}
        </div>
        <span className="min-w-0 truncate text-[11px] font-medium uppercase text-text-2">
          {node.name}
        </span>
        <div className="flex-1" />
        <span
          className={`${COUNT_BADGE.base} ${getCountBadgeSizeClass(sectionCount)} ${countBadgeVariant}`}
        >
          {sectionCount}
        </span>
      </div>
    );
  }

  const isExpanded = node.expanded;
  const isDirectory = node.nodeType === "directory";
  const gitStatus: GitStatusInfo | null =
    isDirectory && node.treeNode?.aggregateStatus
      ? { status: node.treeNode.aggregateStatus, staged: false }
      : node.file
        ? { status: node.file.status, staged: node.file.staged }
        : null;

  return (
    <div
      className={stickyRowClass}
      style={stickyRowPadding(depth)}
      onClick={onClick}
      title={t("tooltips.scrollToItem", { name: node.name })}
    >
      <div className={STICKY_ROW.chevronBox}>
        {isExpanded ? (
          <ChevronDown size={CHEVRON_SIZE} className={STICKY_ROW.chevronIcon} />
        ) : (
          <ChevronRight
            size={CHEVRON_SIZE}
            className={STICKY_ROW.chevronIcon}
          />
        )}
      </div>

      {!isDirectory && (
        <FileTypeIcon
          fileName={node.name}
          size="small"
          className="flex-shrink-0 text-text-2"
        />
      )}

      <span className={STICKY_ROW.name}>{node.name}</span>

      <GitStatusBadge status={gitStatus} isDirectory={isDirectory} />
    </div>
  );
};
