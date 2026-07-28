/**
 * Utility functions for DOMTreeContent
 */
import type { DOMTreeNode } from "@src/modules/WorkStation/Browser/hooks/useWebviewDOMTree";

import type { FlattenedDOMNode } from "./types";

const DOM_TREE_VIRTUALIZATION_THRESHOLD = 50;

/** Flatten the visible portion of a DOM tree for list rendering. */
export function flattenDOMTree(
  tree: DOMTreeNode | null,
  expandedNodes: Set<string>
): FlattenedDOMNode[] {
  if (!tree) return [];

  const result: FlattenedDOMNode[] = [];

  function traverse(node: DOMTreeNode, depth: number): void {
    result.push({ node, depth });

    // Only traverse children if expanded
    if (expandedNodes.has(node.xpath) && node.children.length > 0) {
      for (const child of node.children) {
        traverse(child, depth + 1);
      }
    }
  }

  traverse(tree, 0);
  return result;
}

export function shouldVirtualizeDOMTree(nodeCount: number): boolean {
  return nodeCount > DOM_TREE_VIRTUALIZATION_THRESHOLD;
}

/** Find a node index by xpath in the flattened visible list. */
export function findNodeIndex(
  flattenedNodes: FlattenedDOMNode[],
  xpath: string
): number {
  return flattenedNodes.findIndex((item) => item.node.xpath === xpath);
}
