/**
 * Test Tree Utility Functions
 */
import type { TestItem } from "@src/types/testing/types";

import type { FlattenedTestNode, TestTreeNode } from "../types";

/**
 * Convert TestItem to TestTreeNode
 */
function testItemToTreeNode(
  item: TestItem,
  expandedPaths: Set<string>
): TestTreeNode {
  const hasChildren = item.children && item.children.length > 0;
  return {
    path: item.id,
    name: item.name,
    isFolder: hasChildren,
    expanded: hasChildren ? expandedPaths.has(item.id) : false,
    testItem: item,
    status: item.status,
    duration: item.duration,
  };
}

/**
 * Flatten test tree for virtualization.
 * Recursively flattens expanded nodes while preserving depth.
 */
export function flattenTestTree(
  items: TestItem[],
  expandedPaths: Set<string>
): FlattenedTestNode[] {
  const result: FlattenedTestNode[] = [];

  function flatten(itemList: TestItem[], depth: number = 0) {
    for (const item of itemList) {
      const node = testItemToTreeNode(item, expandedPaths);
      result.push({ node, depth });

      if (node.isFolder && node.expanded && item.children) {
        flatten(item.children, depth + 1);
      }
    }
  }

  flatten(items);
  return result;
}

/**
 * Get all parent paths for sticky headers
 */
export function getAncestorPaths(_path: string): string[] {
  // For test items, the path is the id which may contain parent info
  // This is a simplified version - adjust based on actual id structure
  return [];
}
