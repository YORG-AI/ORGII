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
    log.error(`[useCodeEditor] Failed to read directory ${dirPath}:`, {
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
      return { ...node, children, expanded: true };
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
function collectExpandedPaths(nodes: FileNode[]): string[] {
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
    return newNodes;
  }

  try {
    const treeEntries = await invoke<TreeEntry[]>("list_directory_tree", {
      dirPath: repoPath,
      repoPath,
      expandedPaths,
    });

    return treeEntries.map(treeEntryToFileNode);
  } catch {
    return newNodes;
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
