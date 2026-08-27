/**
 * TestingContent Component
 *
 * Test explorer panel for the left sidebar.
 * Uses VirtualizedStickyTree for efficient rendering of large test suites.
 * Styled to match VS Code Test Explorer and other tree views.
 *
 * Uses dispatch() for actions (unified with AI commands).
 */
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronRight, Filter as FilterIcon } from "lucide-react";
import React, {
  memo,
  useCallback,
  useDeferredValue,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { useActionSystem } from "@src/ActionSystem";
import Input from "@src/components/Input";
import { TREE_ROW_HEIGHT } from "@src/components/TreeRow";
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
import { useTestRunner } from "@src/modules/WorkStation/CodeEditor/hooks/useTestRunner";
import { HUMANTOOLS_TEXT_KEYS } from "@src/modules/WorkStation/shared";
import { usePrimarySidebarSurface } from "@src/modules/WorkStation/shared/hooks/usePrimarySidebarSurface";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { testItemsWithStatusAtom } from "@src/store/workstation/codeEditor/testRunner";

import TestTreeRow from "./TestTreeRow";
import type { TestTreeNode, TestingContentProps } from "./types";
import { flattenTestTree } from "./utils/treeUtils";

// Re-export types
export type { TestingContentProps } from "./types";

// ============================================
// Component
// ============================================

// Helper to collect all expandable paths from test items
function collectAllExpandablePaths(
  items: { id: string; children?: { id: string; children?: unknown[] }[] }[]
): Set<string> {
  const paths = new Set<string>();
  const collect = (itemList: typeof items) => {
    for (const item of itemList) {
      if (item.children && item.children.length > 0) {
        paths.add(item.id);
        collect(item.children as typeof items);
      }
    }
  };
  collect(items);
  return paths;
}

function filterTestItems(
  items: import("@src/types/testing/types").TestItem[],
  query: string
): import("@src/types/testing/types").TestItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return items;

  const filterRecursive = (
    itemList: import("@src/types/testing/types").TestItem[]
  ): import("@src/types/testing/types").TestItem[] =>
    itemList
      .map((item) => {
        const filteredChildren = filterRecursive(item.children ?? []);
        const selfMatches =
          item.name.toLowerCase().includes(normalizedQuery) ||
          item.path.toLowerCase().includes(normalizedQuery);

        if (!selfMatches && filteredChildren.length === 0) {
          return null;
        }

        return {
          ...item,
          children: filteredChildren,
        };
      })
      .filter(
        (item): item is import("@src/types/testing/types").TestItem =>
          item !== null
      );

  return filterRecursive(items);
}

export const TestingContent: React.FC<TestingContentProps> = memo(
  ({ repoPath, isActive = true, onFileClick, showFilter = false }) => {
    const { t } = useTranslation();
    const { stickyBgClass } = usePrimarySidebarSurface();
    // Dispatch for actions (unified with AI)
    const { dispatch } = useActionSystem();
    const [filterQuery, setFilterQuery] = useState("");
    const deferredFilterQuery = useDeferredValue(filterQuery);

    // Hook for state only (no action calls)
    const { isDiscovering, counts } = useTestRunner({
      repoPath,
      autoDiscover: true,
      isActive,
    });

    const testItems = useAtomValue(testItemsWithStatusAtom);
    const filteredItems = useMemo(
      () => filterTestItems(testItems, deferredFilterQuery),
      [testItems, deferredFilterQuery]
    );

    // Track user-toggled paths (collapsed by user)
    const [userCollapsedPaths, setUserCollapsedPaths] = useState<Set<string>>(
      () => new Set()
    );

    // By default all paths are expanded. We track which ones the user has collapsed.
    // Expanded paths = all expandable paths - user collapsed paths
    const expandedPaths = useMemo(() => {
      const allPaths = collectAllExpandablePaths(filteredItems);
      // Remove any paths the user has manually collapsed
      for (const path of userCollapsedPaths) {
        allPaths.delete(path);
      }
      return allPaths;
    }, [filteredItems, userCollapsedPaths]);

    // Flatten the test tree for virtualization
    const flattenedNodes = useMemo(
      () => flattenTestTree(filteredItems, expandedPaths),
      [filteredItems, expandedPaths]
    );

    // Handle toggle directory (expand/collapse)
    // Toggle by adding/removing from user collapsed paths
    const handleToggle = useCallback((path: string) => {
      setUserCollapsedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          // Was collapsed by user, now expand
          next.delete(path);
        } else {
          // Collapse it
          next.add(path);
        }
        return next;
      });
    }, []);

    // Handle run single test - via dispatch
    const handleRunTest = useCallback(
      (testId: string) => {
        dispatch("test.run", { testId }, "user");
      },
      [dispatch]
    );

    // Handle file click - convert relative path to absolute
    const handleFileClick = useCallback(
      (relativePath: string) => {
        if (onFileClick && repoPath) {
          const absolutePath = `${repoPath}/${relativePath}`;
          onFileClick(absolutePath);
        }
      },
      [onFileClick, repoPath]
    );

    // Render a single tree item
    const renderItem = useCallback(
      (item: FlattenedTreeNode<TestTreeNode>) => (
        <TestTreeRow
          node={item.node}
          depth={item.depth}
          onRunTest={handleRunTest}
          onToggle={handleToggle}
          onFileClick={handleFileClick}
        />
      ),
      [handleRunTest, handleToggle, handleFileClick]
    );

    // Render a sticky header item (for folders/suites)
    const renderStickyItem = useCallback(
      (stickyNode: StickyScrollNode<TestTreeNode>, onClick: () => void) => {
        const { node, depth } = stickyNode;
        const isExpanded = node.expanded;

        return (
          <div
            className={`${STICKY_ROW.rowBase} ${stickyBgClass}`}
            style={stickyRowPadding(depth)}
            onClick={onClick}
            title={t("tooltips.scrollToItem", { name: node.name })}
          >
            <div className={STICKY_ROW.chevronBox}>
              {isExpanded ? (
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

            <span className={STICKY_ROW.name}>{node.name}</span>
          </div>
        );
      },
      [stickyBgClass, t]
    );

    // Handle sticky header click
    // VS Code pattern: scroll-to-reveal only, never toggle collapse
    const handleStickyHeaderClick = useCallback((_nodePath: string) => {}, []);

    if (!isActive) {
      return null;
    }

    return (
      <div className="flex h-full w-full flex-col">
        {showFilter && (
          <div className="flex-shrink-0 px-3 pb-2">
            <Input
              prefix={<FilterIcon size={14} strokeWidth={1.75} />}
              placeholder={t("placeholders.filterSearch")}
              value={filterQuery}
              onChange={setFilterQuery}
              size="small"
              className="input-pane-surface"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>
        )}

        {/* Info bar at top - similar to source control structure */}
        {counts.total > 0 && (
          <div className="flex-shrink-0 px-3 pb-2">
            <div className="flex items-center gap-1.5 text-[11px]">
              {counts.passed > 0 && (
                <span className="text-success-6">✓ {counts.passed}</span>
              )}
              {counts.failed > 0 && (
                <span className="text-danger-6">✕ {counts.failed}</span>
              )}
              {counts.skipped > 0 && (
                <span className="text-text-4">○ {counts.skipped}</span>
              )}
            </div>
          </div>
        )}

        {/* Virtualized tree content */}
        <div className="min-h-0 flex-1">
          {isDiscovering ? (
            <Placeholder
              variant="loading"
              placement="sidebar"
              title={t("placeholders.discoveringTests")}
              fillParentHeight
            />
          ) : testItems.length === 0 ? (
            <Placeholder
              variant="empty"
              placement="sidebar"
              title={t(HUMANTOOLS_TEXT_KEYS.placeholders.noTestsFound)}
              fillParentHeight
            />
          ) : filteredItems.length === 0 ? (
            <Placeholder
              variant="empty"
              placement="sidebar"
              title={t("placeholders.noMatchingResults")}
              fillParentHeight
            />
          ) : (
            <VirtualizedStickyTree
              flattenedNodes={
                flattenedNodes as FlattenedTreeNode<TestTreeNode>[]
              }
              rowHeight={TREE_ROW_HEIGHT}
              renderItem={renderItem}
              renderStickyItem={renderStickyItem}
              onStickyHeaderClick={handleStickyHeaderClick}
              emptyMessage={t(HUMANTOOLS_TEXT_KEYS.placeholders.noTestsFound)}
              stickyBgClass={stickyBgClass}
            />
          )}
        </div>
      </div>
    );
  }
);

TestingContent.displayName = "TestingContent";

export default TestingContent;
