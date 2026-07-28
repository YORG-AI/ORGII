import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/modules/shared/layouts/blocks";

import { DOMTreeList } from "./DOMTreeList";
import type { DOMTreeContentProps } from "./types";
import { flattenDOMTree, shouldVirtualizeDOMTree } from "./utils";

export const DOMTreeContent = memo(function DOMTreeContent({
  tree,
  expandedNodes,
  selectedXPath,
  highlightedXPath,
  onToggle,
  onSelect,
  onHover,
  loading = false,
  error = null,
  emptyMessage,
  revealXPath,
  revealKey,
}: DOMTreeContentProps) {
  const { t } = useTranslation();
  const flattenedNodes = useMemo(
    () => flattenDOMTree(tree, expandedNodes),
    [expandedNodes, tree]
  );

  if (loading && !tree) {
    return (
      <Placeholder
        variant="loading"
        placement="detail-panel"
        fillParentHeight
      />
    );
  }

  if (error && !error.toLowerCase().includes("not found")) {
    return (
      <Placeholder
        variant="error"
        placement="detail-panel"
        title={error}
        fillParentHeight
      />
    );
  }

  if (!tree || flattenedNodes.length === 0) {
    return (
      <Placeholder
        variant="empty"
        placement="sidebar"
        title={emptyMessage ?? t("placeholders.noDomTree")}
        fillParentHeight
      />
    );
  }

  return (
    <DOMTreeList
      nodes={flattenedNodes}
      expandedNodes={expandedNodes}
      selectedXPath={selectedXPath}
      highlightedXPath={highlightedXPath}
      virtualized={shouldVirtualizeDOMTree(flattenedNodes.length)}
      revealXPath={revealXPath}
      revealKey={revealKey}
      onToggle={onToggle}
      onSelect={onSelect}
      onHover={onHover}
    />
  );
});

export default DOMTreeContent;
