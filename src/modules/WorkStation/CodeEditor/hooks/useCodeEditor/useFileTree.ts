/**
 * useFileTree - File tree management sub-hook
 *
 * Handles loading, expanding/collapsing, revealing files,
 * and auto-refreshing the file tree on filesystem changes.
 */
import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import { createLogger } from "@src/hooks/logger";
import type { FileNode } from "@src/store/workstation/codeEditor/file";
import {
  fileLoadingTreeAtom,
  fileSelectedPathAtom,
  fileTreeAtom,
  fileTreeErrorAtom,
} from "@src/store/workstation/codeEditor/file";

import {
  COLLAPSED_SUBTREE_RETENTION_MS,
  COLLAPSED_SUBTREE_SWEEP_MS,
  MAX_RETAINED_TREE_NODES,
  collectExpandedPaths,
  countTreeNodes,
  ensureGitignoreChecker,
  findNodeInTree,
  loadDirectoryContents,
  loadDirectorySubtree,
  mergeTreeReloadingExpanded,
  pruneCollapsedSubtree,
  updateTreeChildren,
  updateTreeExpansion,
} from "./helpers";

const log = createLogger("useCodeEditor");

// ============================================
// Types
// ============================================

export interface UseFileTreeReturn {
  fileTree: FileNode[];
  loadingTree: boolean;
  treeError: string | null;
  loadFileTree: () => Promise<void>;
  toggleDirectory: (path: string) => void;
  collapseAll: () => void;
  revealFile: (filePath: string) => Promise<void>;
}

// ============================================
// Hook
// ============================================

export function useFileTree(
  repoPath: string,
  autoLoad: boolean
): UseFileTreeReturn {
  // State
  const [fileTree, setFileTree] = useAtom(fileTreeAtom);
  const [loadingTree, setLoadingTree] = useAtom(fileLoadingTreeAtom);
  const [treeError, setTreeError] = useAtom(fileTreeErrorAtom);
  const setSelectedFile = useSetAtom(fileSelectedPathAtom);

  // Ref for fileTree to avoid dependency in toggleDirectory/revealFile
  const fileTreeRef = useRef<FileNode[]>(fileTree);
  useEffect(() => {
    fileTreeRef.current = fileTree;
  }, [fileTree]);

  // ============================================
  // Collapsed-subtree pruning
  // ============================================
  //
  // Collapsing only flips `expanded`; the loaded children stay so that
  // re-opening a folder is instant. Without a bound the tree grows with every
  // directory ever browsed. Collapsed directories are timestamped here and a
  // sweep drops their children once they have been closed for
  // COLLAPSED_SUBTREE_RETENTION_MS (immediately when the tree exceeds
  // MAX_RETAINED_TREE_NODES), remembering which descendants were expanded so
  // the next expansion restores the same view from a fresh directory read.
  const collapsedAtRef = useRef<Map<string, number>>(new Map());

  const pruneCollapsedPaths = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      for (const path of paths) {
        collapsedAtRef.current.delete(path);
      }
      setFileTree((prev) => {
        let next = prev;
        for (const path of paths) {
          next = pruneCollapsedSubtree(next, path);
        }
        return next;
      });
    },
    [setFileTree]
  );

  const sweepCollapsedSubtrees = useCallback(
    (force: boolean) => {
      const collapsedAt = collapsedAtRef.current;
      if (collapsedAt.size === 0) return;
      const now = Date.now();
      const expired: string[] = [];
      for (const [path, at] of collapsedAt) {
        const node = findNodeInTree(fileTreeRef.current, path);
        if (!node || node.type !== "directory" || node.expanded) {
          collapsedAt.delete(path);
          continue;
        }
        if (!node.children || node.children.length === 0) {
          collapsedAt.delete(path);
          continue;
        }
        if (force || now - at >= COLLAPSED_SUBTREE_RETENTION_MS) {
          expired.push(path);
        }
      }
      pruneCollapsedPaths(expired);
    },
    [pruneCollapsedPaths]
  );

  const noteCollapsed = useCallback(
    (paths: string[]) => {
      const now = Date.now();
      for (const path of paths) {
        collapsedAtRef.current.set(path, now);
      }
      if (countTreeNodes(fileTreeRef.current) > MAX_RETAINED_TREE_NODES) {
        sweepCollapsedSubtrees(true);
      }
    },
    [sweepCollapsedSubtrees]
  );

  useEffect(() => {
    const timer = setInterval(
      () => sweepCollapsedSubtrees(false),
      COLLAPSED_SUBTREE_SWEEP_MS
    );
    return () => clearInterval(timer);
  }, [sweepCollapsedSubtrees]);

  // ============================================
  // Load file tree
  // ============================================

  const loadFileTree = useCallback(async () => {
    if (!repoPath) {
      setTreeError("No repo path provided");
      return;
    }

    setLoadingTree(true);
    setTreeError(null);

    try {
      await ensureGitignoreChecker(repoPath);
      const tree = await loadDirectoryContents(repoPath, false, repoPath);
      const prev = fileTreeRef.current;
      const merged =
        prev.length === 0
          ? tree
          : await mergeTreeReloadingExpanded(tree, prev, repoPath);
      setFileTree(merged);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to load file tree";
      setTreeError(errorMessage);
      log.error("[useCodeEditor] Error loading file tree:", err);
    } finally {
      setLoadingTree(false);
    }
  }, [repoPath, setFileTree, setLoadingTree, setTreeError]);

  // ============================================
  // Toggle directory expansion
  // ============================================

  const toggleDirectory = useCallback(
    async (path: string) => {
      const node = findNodeInTree(fileTreeRef.current, path);
      if (!node || node.type !== "directory") return;

      // If already expanded, just collapse
      if (node.expanded) {
        setFileTree((prev) => updateTreeExpansion(prev, path, false));
        noteCollapsed([path]);
        return;
      }

      collapsedAtRef.current.delete(path);

      // If not loaded yet (or pruned), load children — restoring whatever
      // descendants were expanded before the subtree was dropped.
      if (!node.children || node.children.length === 0) {
        try {
          const children = await loadDirectorySubtree(
            path,
            repoPath,
            node.retainedExpandedPaths
          );
          setFileTree((prev) => updateTreeChildren(prev, path, children));
        } catch (err) {
          log.error("[useCodeEditor] Error loading directory:", {
            path,
            error: err,
          });
          setFileTree((prev) => updateTreeChildren(prev, path, []));
        }
      } else {
        setFileTree((prev) => updateTreeExpansion(prev, path, true));
      }
    },
    [repoPath, setFileTree, noteCollapsed]
  );

  // ============================================
  // Collapse all directories
  // ============================================

  const collapseAll = useCallback(() => {
    const collapseNodes = (nodes: FileNode[]): FileNode[] => {
      return nodes.map((node) => ({
        ...node,
        expanded: false,
        children: node.children ? collapseNodes(node.children) : node.children,
      }));
    };

    const wereExpanded = collectExpandedPaths(fileTreeRef.current);
    setFileTree((prev) => collapseNodes(prev));
    noteCollapsed(wereExpanded);
  }, [setFileTree, noteCollapsed]);

  // ============================================
  // Reveal file in tree
  // ============================================

  /**
   * Reveal a file in the tree by expanding all parent directories.
   *
   * PERFORMANCE: Batches all tree updates into a single setFileTree call
   * to avoid multiple re-renders when revealing deeply nested files.
   */
  const revealFile = useCallback(
    async (filePath: string) => {
      if (!filePath || !repoPath) return;

      // Normalize to absolute path
      const absolutePath = filePath.startsWith(repoPath)
        ? filePath
        : filePath.startsWith("/")
          ? filePath
          : `${repoPath}/${filePath}`;

      // Compute relative path from repo root
      const relativePath = absolutePath.startsWith(repoPath)
        ? absolutePath.slice(repoPath.length).replace(/^\//, "")
        : absolutePath;

      // Get all parent directory paths
      const parts = relativePath.split("/");
      const parentPaths: string[] = [];

      for (let idx = 0; idx < parts.length - 1; idx++) {
        const partialPath = parts.slice(0, idx + 1).join("/");
        parentPaths.push(`${repoPath}/${partialPath}`);
      }

      // Keep a local copy of the tree
      let localTree = fileTreeRef.current;
      let treeChanged = false;

      // Expand each parent directory in order
      // PERFORMANCE: Only mutate localTree, defer setFileTree until the end
      for (const dirPath of parentPaths) {
        const dirNode = findNodeInTree(localTree, dirPath);
        if (!dirNode || dirNode.type !== "directory") continue;

        if (!dirNode.expanded) {
          treeChanged = true;
          collapsedAtRef.current.delete(dirPath);
          if (!dirNode.children || dirNode.children.length === 0) {
            try {
              const children = await loadDirectorySubtree(
                dirPath,
                repoPath,
                dirNode.retainedExpandedPaths
              );
              localTree = updateTreeChildren(localTree, dirPath, children);
            } catch (err) {
              log.error("[useCodeEditor] Error revealing file:", {
                dirPath,
                error: err,
              });
            }
          } else {
            localTree = updateTreeExpansion(localTree, dirPath, true);
          }
        }
      }

      // PERFORMANCE: Single tree update at the end instead of per-directory
      if (treeChanged) {
        setFileTree(localTree);
      }

      // Select the file
      setSelectedFile(absolutePath);
    },
    [repoPath, setFileTree, setSelectedFile]
  );

  // ============================================
  // Auto-load file tree on mount
  // ============================================

  useEffect(() => {
    if (autoLoad && repoPath) {
      // Load immediately — the shell is already rendered by the time this
      // effect fires (React effects run after paint). No need to defer
      // further with requestIdleCallback which added 300ms to first-load.
      loadFileTree();
    }
  }, [autoLoad, repoPath, loadFileTree]);

  // ============================================
  // Auto-refresh file tree on filesystem changes
  // ============================================
  // Listen for repo:status_updated WebSocket events. When the set of tracked
  // file paths changes (new files added, files deleted, files renamed) we
  // trigger a debounced tree reload so the explorer stays in sync.
  // Gated by autoLoad to prevent clobbering multi-root tree state.

  const previousFilePathsRef = useRef<Set<string>>(new Set());
  const treeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  useEffect(() => {
    if (!autoLoad || !repoPath) return;

    const websocket = getCodeEditorWebSocket();
    if (!websocket) return;

    let mounted = true;

    const unsubscribe = websocket.on("repo:status_updated", (data) => {
      if (!mounted) return;
      if (document.hidden) return;

      const payload = data as {
        repo_id?: string;
        status?: {
          files?: Array<{ path: string; status: string; staged: boolean }>;
          untracked?: number;
        };
      };

      const currentPaths = new Set<string>(
        (payload.status?.files ?? []).map((file) => file.path)
      );

      const previousPaths = previousFilePathsRef.current;

      let hasStructuralChange = false;

      if (currentPaths.size !== previousPaths.size) {
        hasStructuralChange = true;
      } else {
        for (const path of currentPaths) {
          if (!previousPaths.has(path)) {
            hasStructuralChange = true;
            break;
          }
        }
      }

      previousFilePathsRef.current = currentPaths;

      if (hasStructuralChange) {
        if (treeRefreshTimerRef.current) {
          clearTimeout(treeRefreshTimerRef.current);
        }
        treeRefreshTimerRef.current = setTimeout(() => {
          if (mounted) {
            loadFileTree();
          }
          treeRefreshTimerRef.current = null;
        }, 500);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
      if (treeRefreshTimerRef.current) {
        clearTimeout(treeRefreshTimerRef.current);
        treeRefreshTimerRef.current = null;
      }
    };
  }, [autoLoad, repoPath, loadFileTree]);

  return {
    fileTree,
    loadingTree,
    treeError,
    loadFileTree,
    toggleDirectory,
    collapseAll,
    revealFile,
  };
}
