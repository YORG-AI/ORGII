import React from "react";

import { TreeRowBase, type TreeRowNode } from "@src/components/TreeRow";
import {
  COUNT_BADGE,
  getCountBadgeSizeClass,
} from "@src/modules/WorkStation/shared/tokens";

interface TreeSectionHeaderProps {
  id: string;
  title: string;
  collapsed: boolean;
  count?: number | null;
  onToggle: () => void;
}

export const TreeSectionHeader: React.FC<TreeSectionHeaderProps> = ({
  id,
  title,
  collapsed,
  count,
  onToggle,
}) => {
  const node: TreeRowNode = {
    id,
    name: title,
    path: id,
    type: "directory",
    expanded: !collapsed,
  };

  const countBadgeVariant =
    count === 0 ? COUNT_BADGE.muted : COUNT_BADGE.primary;

  return (
    <TreeRowBase
      node={node}
      depth={0}
      onClick={onToggle}
      showIndentGuides={false}
      className="[&_.min-w-0]:text-[11px] [&_.min-w-0]:font-medium [&_.min-w-0]:uppercase [&_.min-w-0]:text-text-2"
    >
      {count != null && (
        <span
          className={`${COUNT_BADGE.base} ${getCountBadgeSizeClass(count)} ${countBadgeVariant}`}
        >
          {count}
        </span>
      )}
    </TreeRowBase>
  );
};
