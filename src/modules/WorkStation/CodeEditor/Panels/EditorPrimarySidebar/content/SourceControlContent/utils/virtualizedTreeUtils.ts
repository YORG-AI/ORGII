/**
 * Virtualized Tree Utilities for Source Control
 *
 * Converts section-based git file lists into a flattened structure
 * suitable for VirtualizedStickyTree.
 */
import type { GitFile } from "@src/types/git/types";

import type { GitFileTreeNode } from "../components/GitFileTreeItem";
import { buildVSCodeStyleTree, flattenGitFileTree } from "./treeUtils";

// ============================================
// Types
// ============================================

export type SourceControlNodeType =
  | "section-header"
  | "file"
  | "directory"
  | "stash-section"
  | "stash-item";

export interface SourceControlNode {
  /** Unique path/id */
  path: string;
  /** Display name */
  name: string;
  /** Whether it's a folder */
  isFolder: boolean;
  /** Whether expanded (for folders) */
  expanded: boolean;
  /** Node type for rendering */
  nodeType: SourceControlNodeType;
  /** Section identifier (merge/staged/unstaged/stash) */
  section?: "merge" | "staged" | "unstaged" | "stash";
  /** Original git file (for file nodes) */
  file?: GitFile;
  /** Original tree node (for directory nodes) */
  treeNode?: GitFileTreeNode;
  /** Count for section headers */
  count?: number;
  /** Loading state for section */
  loading?: boolean;
  /** Section variant (for styling) */
  variant?: "default" | "warning";
}

export interface FlattenedSourceControlNode {
  node: SourceControlNode;
  depth: number;
}

export interface SectionLabels {
  mergeChanges: string;
  stagedChanges: string;
  changes: string;
}

export interface FlattenSectionOptions {
  conflictFiles: GitFile[];
  stagedFiles: GitFile[];
  unstagedFiles: GitFile[];
  collapsedDirs: Set<string>;
  mergeCollapsed: boolean;
  stagedCollapsed: boolean;
  changesCollapsed: boolean;
  viewMode: "list-tree" | "list";
  loading?: boolean;
  /** Translated section labels */
  sectionLabels: SectionLabels;
}

// ============================================
// Helpers
// ============================================

/**
 * Apply collapsed state to tree nodes
 */
function applyExpandedState(
  nodes: GitFileTreeNode[],
  collapsedDirs: Set<string>
): GitFileTreeNode[] {
  return nodes.map((node) => {
    if (node.type === "directory") {
      return {
        ...node,
        expanded: !collapsedDirs.has(node.path),
        children: node.children
          ? applyExpandedState(node.children, collapsedDirs)
          : undefined,
      };
    }
    return node;
  });
}

/**
 * Convert GitFileTreeNode to SourceControlNode
 */
function treeNodeToSourceControlNode(
  treeNode: GitFileTreeNode,
  section: "merge" | "staged" | "unstaged"
): SourceControlNode {
  return {
    path: `${section}:${treeNode.path}`,
    name: treeNode.name,
    isFolder: treeNode.type === "directory",
    expanded: treeNode.expanded ?? true,
    nodeType: treeNode.type === "directory" ? "directory" : "file",
    section,
    file: treeNode.file,
    treeNode,
  };
}

/**
 * Flatten a file tree with its section header
 */
function flattenSection(
  sectionId: "merge" | "staged" | "unstaged",
  sectionName: string,
  files: GitFile[],
  collapsedDirs: Set<string>,
  isCollapsed: boolean,
  viewMode: "list-tree" | "list",
  options?: { variant?: "default" | "warning"; loading?: boolean }
): FlattenedSourceControlNode[] {
  if (files.length === 0) return [];

  const result: FlattenedSourceControlNode[] = [];

  // Add section header
  result.push({
    node: {
      path: `section:${sectionId}`,
      name: sectionName,
      isFolder: true,
      expanded: !isCollapsed,
      nodeType: "section-header",
      section: sectionId,
      count: files.length,
      variant: options?.variant,
      loading: options?.loading,
    },
    depth: 0,
  });

  // Add files if not collapsed
  if (!isCollapsed) {
    if (viewMode === "list-tree") {
      // Tree mode: build tree and flatten
      const tree = buildVSCodeStyleTree(files);
      const expandedTree = applyExpandedState(tree, collapsedDirs);
      const flattened = flattenGitFileTree(expandedTree);

      for (const { node: treeNode, depth } of flattened) {
        result.push({
          node: treeNodeToSourceControlNode(treeNode, sectionId),
          depth: depth + 1, // +1 because section header is at depth 0
        });
      }
    } else {
      // List mode: flat list of files
      for (const file of files) {
        result.push({
          node: {
            path: `${sectionId}:${file.path}`,
            name: file.path.split("/").pop() ?? file.path,
            isFolder: false,
            expanded: false,
            nodeType: "file",
            section: sectionId,
            file,
          },
          depth: 1,
        });
      }
    }
  }

  return result;
}

// ============================================
// Main Export
// ============================================

/**
 * Flatten all source control sections into a single virtualized list
 */
export function flattenSourceControlTree(
  options: FlattenSectionOptions
): FlattenedSourceControlNode[] {
  const {
    conflictFiles,
    stagedFiles,
    unstagedFiles,
    collapsedDirs,
    mergeCollapsed,
    stagedCollapsed,
    changesCollapsed,
    viewMode,
    loading,
    sectionLabels,
  } = options;

  const result: FlattenedSourceControlNode[] = [];

  // Merge Changes section (if has conflicts)
  result.push(
    ...flattenSection(
      "merge",
      sectionLabels.mergeChanges,
      conflictFiles,
      collapsedDirs,
      mergeCollapsed,
      viewMode,
      { variant: "warning" }
    )
  );

  // Staged Changes section
  result.push(
    ...flattenSection(
      "staged",
      sectionLabels.stagedChanges,
      stagedFiles,
      collapsedDirs,
      stagedCollapsed,
      viewMode
    )
  );

  // Changes (unstaged) section
  result.push(
    ...flattenSection(
      "unstaged",
      sectionLabels.changes,
      unstagedFiles,
      collapsedDirs,
      changesCollapsed,
      viewMode,
      { loading }
    )
  );

  return result;
}
