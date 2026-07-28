/**
 * Simulator File Tree Utilities
 *
 * Converts flat file operation lists into a hierarchical tree structure
 * compatible with VirtualizedStickyTree + TreeRowBase.
 *
 * Features:
 * - Builds directory tree from flat file paths
 * - Compacts single-child directory chains (src/components → "src/components")
 * - Sorts directories first, then files alphabetically
 * - Filters tree while preserving ancestor directories
 * - Flattens tree for virtualized rendering
 */
import type { ReactNode } from "react";

import type {
  FlattenedTreeNode,
  TreeNodeBase,
} from "@src/components/VirtualizedStickyTree";

// ============================================
// Types
// ============================================

export interface SimulatorTreeNode extends TreeNodeBase {
  id: string;
  type: "file" | "directory";
  eventId?: string;
  statusLabel?: string;
  statusColorClass?: string;
  isAgentSelected?: boolean;
  icon?: ReactNode;
  children: SimulatorTreeNode[];
}

export interface FileTreeInput {
  id: string;
  /** Path segments used only to build the directory tree (may be synthetic for flat mode). */
  filePath: string;
  fileName: string;
  /** When set, used as the leaf node's `path` (tooltips, path hint) instead of `filePath`. */
  logicalPath?: string;
  isAgentSelected?: boolean;
  statusLabel?: string;
  statusColorClass?: string;
  icon?: ReactNode;
}

// ============================================
// Build Tree
// ============================================

export function buildFileTree(items: FileTreeInput[]): SimulatorTreeNode[] {
  if (items.length === 0) return [];

  const dirMap = new Map<string, SimulatorTreeNode>();
  const rootChildren: SimulatorTreeNode[] = [];

  for (const item of items) {
    const segments = item.filePath.split("/").filter(Boolean);
    let parentChildren = rootChildren;
    let currentPath = "";

    for (let idx = 0; idx < segments.length - 1; idx++) {
      currentPath = currentPath
        ? `${currentPath}/${segments[idx]}`
        : segments[idx];

      if (!dirMap.has(currentPath)) {
        const dirNode: SimulatorTreeNode = {
          id: `dir:${currentPath}`,
          path: currentPath,
          name: segments[idx],
          type: "directory",
          isFolder: true,
          children: [],
        };
        dirMap.set(currentPath, dirNode);
        parentChildren.push(dirNode);
      }

      parentChildren = dirMap.get(currentPath)!.children;
    }

    const leafPath = item.logicalPath ?? item.filePath;
    const fileNode: SimulatorTreeNode = {
      id: item.id,
      path: leafPath,
      name: item.fileName,
      type: "file",
      isFolder: false,
      eventId: item.id,
      isAgentSelected: item.isAgentSelected,
      statusLabel: item.statusLabel,
      statusColorClass: item.statusColorClass,
      children: [],
    };

    if (item.icon !== undefined) {
      fileNode.icon = item.icon;
    }

    parentChildren.push(fileNode);
  }

  return sortNodes(compactSingleChildDirs(rootChildren));
}

// ============================================
// Compact single-child directory chains
// ============================================

function compactSingleChildDirs(
  nodes: SimulatorTreeNode[]
): SimulatorTreeNode[] {
  return nodes.map((node) => {
    if (node.type !== "directory") return node;

    const compacted = compactSingleChildDirs(node.children);

    if (compacted.length === 1 && compacted[0].type === "directory") {
      const child = compacted[0];
      return {
        ...child,
        id: `dir:${child.path}`,
        name: `${node.name}/${child.name}`,
      };
    }

    return { ...node, children: compacted };
  });
}

// ============================================
// Sort: directories first, then alphabetical
// ============================================

function sortNodes(nodes: SimulatorTreeNode[]): SimulatorTreeNode[] {
  return [...nodes]
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((node) =>
      node.type === "directory"
        ? { ...node, children: sortNodes(node.children) }
        : node
    );
}

// ============================================
// Filter (keeps matching files + ancestor directories)
// ============================================

export function filterFileTree(
  nodes: SimulatorTreeNode[],
  query: string
): SimulatorTreeNode[] {
  if (!query.trim()) return nodes;
  const lower = query.toLowerCase();

  return nodes.reduce<SimulatorTreeNode[]>((acc, node) => {
    if (node.type === "file") {
      if (
        node.name.toLowerCase().includes(lower) ||
        node.path.toLowerCase().includes(lower)
      ) {
        acc.push(node);
      }
    } else {
      const filteredChildren = filterFileTree(node.children, query);
      if (filteredChildren.length > 0) {
        acc.push({ ...node, children: filteredChildren });
      }
    }
    return acc;
  }, []);
}

// ============================================
// Flatten for VirtualizedStickyTree
// ============================================

export function flattenFileTree(
  nodes: SimulatorTreeNode[],
  collapsedPaths: Set<string>,
  depth: number = 0
): FlattenedTreeNode<SimulatorTreeNode>[] {
  const result: FlattenedTreeNode<SimulatorTreeNode>[] = [];

  for (const node of nodes) {
    const isExpanded =
      node.type === "directory" && !collapsedPaths.has(node.path);

    result.push({
      node: { ...node, expanded: isExpanded },
      depth,
    });

    if (isExpanded && node.children.length > 0) {
      result.push(...flattenFileTree(node.children, collapsedPaths, depth + 1));
    }
  }

  return result;
}

// ============================================
// Count leaf file nodes
// ============================================

export function countFileNodes(nodes: SimulatorTreeNode[]): number {
  return nodes.reduce((count, node) => {
    if (node.type === "file") return count + 1;
    return count + countFileNodes(node.children);
  }, 0);
}
