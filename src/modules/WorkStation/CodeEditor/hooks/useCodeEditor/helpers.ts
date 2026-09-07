/**
 * Helper functions and constants for useCodeEditor
 *
 * Pure utility functions for file tree operations,
 * gitignore caching, and directory loading.
 */
import { invoke } from "@tauri-apps/api/core";
import { readDir, stat } from "@tauri-apps/plugin-fs";

import { createLogger } from "@src/hooks/logger";
import type { FileNode } from "@src/store/workstation/codeEditor/file";
import { createGitignoreChecker } from "@src/util/file/gitignoreParser";
import { decodeOctalPath } from "@src/util/file/pathUtils";

const log = createLogger("useCodeEditor");

// ============================================
// Constants
// ============================================

/**
 * A collapsed directory keeps its loaded children this long, so re-expanding
 * a folder the user just closed is instant. Past it the pruner drops the
 * subtree; re-expanding then reads the directory again (a few milliseconds)
 * and restores every descendant that was expanded.
 */
export const COLLAPSED_SUBTREE_RETENTION_MS = 2 * 60 * 1000;

/**
 * Above this many loaded nodes every collapsed subtree is pruned at once,
 * without waiting for the retention window, so a huge repository cannot pin
 * an unbounded tree just because the user browsed it.
 */
export const MAX_RETAINED_TREE_NODES = 20_000;

export const DEFAULT_EXCLUDE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".DS_Store",
];

// ============================================
// Gitignore Cache (module-level singleton)
// ============================================

let gitignoreChecker: {
  isIgnored: (relativePath: string) => boolean;
  refresh: () => Promise<void>;
} | null = null;
let gitignoreRepoPath: string | null = null;

/**
 * Initialize or refresh the gitignore checker for a given repo path.
 * Uses a module-level singleton so it persists across re-renders.
 */
export async function ensureGitignoreChecker(repoPath: string): Promise<void> {
  if (gitignoreRepoPath !== repoPath || !gitignoreChecker) {
    gitignoreChecker = await createGitignoreChecker(repoPath);
    gitignoreRepoPath = repoPath;
  } else {
    await gitignoreChecker.refresh();
  }
}

/**
 * Check if a path is ignored by .gitignore.
 * Returns false if the checker is not initialized.
 */
export function isPathIgnored(
  fullPath: string,
  isDirectory: boolean,
  repoPath: string
): boolean {
  if (!gitignoreChecker) return false;

  const relativePath = fullPath.startsWith(repoPath + "/")
    ? fullPath.substring(repoPath.length + 1)
    : (fullPath.split("/").pop() ?? "");

  const pathToCheck = isDirectory ? relativePath + "/" : relativePath;
  return gitignoreChecker.isIgnored(pathToCheck);
}

// ============================================
// Tree Helper Functions
// ============================================

/**
 * Sort file nodes: directories first, then files, alphabetically
 */
function sortFileNodes(nodes: FileNode[]): FileNode[] {
  return nodes.sort((nodeA, nodeB) => {
    if (nodeA.type === nodeB.type) {
      return nodeA.name.localeCompare(nodeB.name);
    }
    return nodeA.type === "directory" ? -1 : 1;
  });
}

/**
 * Recursively load directory contents from the filesystem
 */
export async function loadDirectoryContents(
  dirPath: string,
  loadChildren: boolean = false,
  repoPath?: string
): Promise<FileNode[]> {
  try {
    const entries = await readDir(dirPath);

    // Resolve symlinks that readDir reports as non-directory — stat follows
    // the symlink and tells us the real target type.
    const symlinkChecks = entries.map((entry) =>
      entry.isSymlink && !entry.isDirectory
        ? stat(`${dirPath}/${entry.name}`)
            .then((info) => info.isDirectory)
            .catch(() => false)
        : Promise.resolve(entry.isDirectory)
    );
    const resolvedIsDir = await Promise.all(symlinkChecks);

    const nodes: FileNode[] = [];

    for (let idx = 0; idx < entries.length; idx++) {
      const entry = entries[idx];
      const name = decodeOctalPath(entry.name);
      const fullPath = `${dirPath}/${name}`;
      const isDir = resolvedIsDir[idx];
      const isIgnored = repoPath
        ? isPathIgnored(fullPath, isDir, repoPath)
        : false;

      const node: FileNode = {
        name,
        path: fullPath,
        type: isDir ? "directory" : "file",
        expanded: false,
        children: isDir ? [] : undefined,
        isSymlink: entry.isSymlink,
        isIgnored,
      };

      if (loadChildren && isDir) {
        node.children = await loadDirectoryContents(node.path, true, repoPath);
      }

      nodes.push(node);
    }

    return sortFileNodes(nodes);
  } catch (error) {
    log.error(`Failed to read directory ${dirPath}:`, {
      error,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Update file tree to expand/collapse a specific directory
 */
export function updateTreeExpansion(
  tree: FileNode[],
  targetPath: string,
  expand: boolean
): FileNode[] {
  return tree.map((node) => {
    if (node.path === targetPath && node.type === "directory") {
      return { ...node, expanded: expand };
    }
    if (node.children) {
      return {
        ...node,
        children: updateTreeExpansion(node.children, targetPath, expand),
      };
    }
    return node;
  });
}

/**
 * Update file tree to set children for a specific directory
 */
export function updateTreeChildren(
  tree: FileNode[],
  targetPath: string,
  children: FileNode[]
): FileNode[] {
  return tree.map((node) => {
    if (node.path === targetPath && node.type === "directory") {
      // Freshly loaded children supersede any remembered expansion.
      const { retainedExpandedPaths: _restored, ...rest } = node;
      return { ...rest, children, expanded: true };
    }
    if (node.children) {
      return {
        ...node,
        children: updateTreeChildren(node.children, targetPath, children),
      };
    }
    return node;
  });
}

/**
 * Collect all expanded directory paths from a file tree.
 */
export function collectExpandedPaths(nodes: FileNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (
      node.type === "directory" &&
      node.expanded &&
      node.children &&
      node.children.length > 0
    ) {
      paths.push(node.path);
      paths.push(...collectExpandedPaths(node.children));
    }
  }
  return paths;
}

/** Count every node currently held in the tree. */
export function countTreeNodes(nodes: FileNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.children) {
      count += countTreeNodes(node.children);
    }
  }
  return count;
}

/**
 * Drop loaded children of the selected collapsed directories in one traversal,
 * remembering which of their
 * descendants were expanded so the next expansion restores the same view.
 * Expanded directories and files are left untouched.
 */
export function pruneCollapsedSubtrees(
  tree: FileNode[],
  targetPaths: ReadonlySet<string>
): FileNode[] {
  return tree.map((node) => {
    if (targetPaths.has(node.path)) {
      if (
        node.type !== "directory" ||
        node.expanded ||
        !node.children ||
        node.children.length === 0
      ) {
        return node;
      }
      const retainedExpandedPaths = collectExpandedPaths(node.children);
      const { children: _dropped, ...rest } = node;
      return retainedExpandedPaths.length > 0
        ? { ...rest, retainedExpandedPaths }
        : rest;
    }
    if (node.children) {
      return {
        ...node,
        children: pruneCollapsedSubtrees(node.children, targetPaths),
      };
    }
    return node;
  });
}

function collectRetainedExpansion(
  nodes: FileNode[],
  into: Map<string, string[]>
): void {
  for (const node of nodes) {
    if (node.retainedExpandedPaths && node.retainedExpandedPaths.length > 0) {
      into.set(node.path, node.retainedExpandedPaths);
    }
    if (node.children) {
      collectRetainedExpansion(node.children, into);
    }
  }
}

function applyRetainedExpansion(
  nodes: FileNode[],
  retained: Map<string, string[]>
): FileNode[] {
  return nodes.map((node) => {
    const remembered =
      node.type === "directory" && !node.expanded && !node.children?.length
        ? retained.get(node.path)
        : undefined;
    const children = node.children
      ? applyRetainedExpansion(node.children, retained)
      : node.children;
    if (remembered) {
      return { ...node, children, retainedExpandedPaths: remembered };
    }
    return children === node.children ? node : { ...node, children };
  });
}

/**
 * Carry the pruner's remembered expansion from a previous tree onto a rebuilt
 * one, so a filesystem-triggered reload does not forget how a pruned folder
 * looked when the user last had it open.
 */
export function carryRetainedExpansion(
  newNodes: FileNode[],
  oldNodes: FileNode[]
): FileNode[] {
  const retained = new Map<string, string[]>();
  collectRetainedExpansion(oldNodes, retained);
  if (retained.size === 0) {
    return newNodes;
  }
  return applyRetainedExpansion(newNodes, retained);
}

interface TreeEntry {
  name: string;
  path: string;
  type: "directory" | "file";
  isSymlink: boolean;
  isIgnored: boolean;
  expanded: boolean;
  children?: TreeEntry[];
}

function treeEntryToFileNode(entry: TreeEntry): FileNode {
  return {
    name: entry.name,
    path: entry.path,
    type: entry.type,
    expanded: entry.expanded,
    children: entry.children?.map(treeEntryToFileNode),
    isSymlink: entry.isSymlink,
    isIgnored: entry.isIgnored,
  };
}

/**
 * Merge freshly loaded root-level tree with previous tree, reloading
 * children for expanded directories from disk so new/deleted files appear.
 *
 * Uses a single Rust `list_directory_tree` command to load the entire
 * expanded subtree in one IPC call, replacing the previous approach of
 * sequential per-directory `readDir` calls.
 */
export async function mergeTreeReloadingExpanded(
  newNodes: FileNode[],
  oldNodes: FileNode[],
  repoPath: string
): Promise<FileNode[]> {
  const expandedPaths = collectExpandedPaths(oldNodes);

  if (expandedPaths.length === 0) {
    return carryRetainedExpansion(newNodes, oldNodes);
  }

  try {
    const treeEntries = await invoke<TreeEntry[]>("list_directory_tree", {
      dirPath: repoPath,
      repoPath,
      expandedPaths,
    });

    return carryRetainedExpansion(
      treeEntries.map(treeEntryToFileNode),
      oldNodes
    );
  } catch {
    return carryRetainedExpansion(newNodes, oldNodes);
  }
}

/**
 * Load a directory's children. When the pruner remembered expanded
 * descendants for it, the whole subtree comes back in one IPC call with
 * those descendants expanded again; otherwise this is a plain directory read.
 */
export async function loadDirectorySubtree(
  dirPath: string,
  repoPath: string,
  expandedPaths: readonly string[] | undefined
): Promise<FileNode[]> {
  if (!expandedPaths || expandedPaths.length === 0) {
    return loadDirectoryContents(dirPath, false, repoPath);
  }
  try {
    const treeEntries = await invoke<TreeEntry[]>("list_directory_tree", {
      dirPath,
      repoPath,
      expandedPaths: [...expandedPaths],
    });
    return treeEntries.map(treeEntryToFileNode);
  } catch (error) {
    log.warn("Subtree reload failed, falling back to a flat read", {
      dirPath,
      error,
    });
    return loadDirectoryContents(dirPath, false, repoPath);
  }
}

/**
 * Find a node in the tree by path
 */
export function findNodeInTree(
  nodes: FileNode[],
  path: string
): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNodeInTree(node.children, path);
      if (found) return found;
    }
  }
  return null;
}
