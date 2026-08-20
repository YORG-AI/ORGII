/**
 * useMultiRootFileTree - Multi-root workspace file tree management
 *
 * Manages independent file trees for each workspace folder root,
 * composing them into a single tree with root header nodes for display.
 *
 * When only one folder is present, behaves identically to the single-root useFileTree.
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
import type { WorkspaceFolder } from "@src/types/workspace";

import {
  ensureGitignoreChecker,
  findNodeInTree,
  loadDirectoryContents,
  mergeTreeReloadingExpanded,
  updateTreeChildren,
  updateTreeExpansion,
} from "./helpers";

const log = createLogger("useMultiRootFileTree");

// ============================================
// Types
// ============================================

export interface RootTree {
  folderId: string;
  folderName: string;
  folderPath: string;
  treeData: FileNode[];
  loading: boolean;
  error: string | null;
}

export interface UseMultiRootFileTreeReturn {
  fileTree: FileNode[];
  roots: RootTree[];
  loadingTree: boolean;
  treeError: string | null;
  loadFileTree: () => Promise<void>;
  loadRoot: (folderId: string) => Promise<void>;
  toggleDirectory: (path: string) => void;
  collapseAll: () => void;
  revealFile: (filePath: string) => Promise<void>;
}

// ============================================
// Constants
// ============================================

const MAX_ROOT_TREES = 20;

// ============================================
// Hook
// ============================================

export function useMultiRootFileTree(
  workspaceFolders: WorkspaceFolder[],
  autoLoad: boolean
): UseMultiRootFileTreeReturn {
  const [fileTree, setFileTree] = useAtom(fileTreeAtom);
  const [loadingTree, setLoadingTree] = useAtom(fileLoadingTreeAtom);
  const [treeError, setTreeError] = useAtom(fileTreeErrorAtom);
  const setSelectedFile = useSetAtom(fileSelectedPathAtom);
  const isMultiRoot = workspaceFolders.length > 1;

  // Per-root tree storage (keyed by folder id)
  const rootTreesRef = useRef<Map<string, RootTree>>(new Map());
  const fileTreeRef = useRef<FileNode[]>(fileTree);

  useEffect(() => {
    fileTreeRef.current = fileTree;
  }, [fileTree]);

  // Get the root tree for a given file path (finds which root owns the path)
  const findRootForPath = useCallback(
    (filePath: string): WorkspaceFolder | undefined => {
      return workspaceFolders.find((folder) =>
        filePath.startsWith(folder.path)
      );
    },
    [workspaceFolders]
  );

  // ============================================
  // Build combined tree from all roots
  // ============================================

  const buildCombinedTree = useCallback(() => {
    if (!isMultiRoot) return;

    const combined: FileNode[] = [];
    for (const folder of workspaceFolders) {
      const rootTree = rootTreesRef.current.get(folder.id);
      const rootNode: FileNode = {
        name: folder.name,
        path: folder.path,
        type: "directory",
        expanded: true,
        children: rootTree?.treeData ?? [],
      };
      combined.push(rootNode);
    }
    setFileTree(combined);
  }, [isMultiRoot, workspaceFolders, setFileTree]);

  // ============================================
  // Load a single root
  // ============================================

  const loadRoot = useCallback(
    async (folderId: string) => {
      const folder = workspaceFolders.find((wf) => wf.id === folderId);
      if (!folder) return;

      const existing = rootTreesRef.current.get(folderId);
      const prevData = existing?.treeData ?? [];

      rootTreesRef.current.set(folderId, {
        folderId,
        folderName: folder.name,
        folderPath: folder.path,
        treeData: prevData,
        loading: true,
        error: null,
      });

      try {
        await ensureGitignoreChecker(folder.path);
        const tree = await loadDirectoryContents(
          folder.path,
          false,
          folder.path
        );
        const merged =
          prevData.length === 0
            ? tree
            : await mergeTreeReloadingExpanded(tree, prevData, folder.path);

        rootTreesRef.current.set(folderId, {
          folderId,
          folderName: folder.name,
          folderPath: folder.path,
          treeData: merged,
          loading: false,
          error: null,
        });
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to load file tree";
        rootTreesRef.current.set(folderId, {
          folderId,
          folderName: folder.name,
          folderPath: folder.path,
          treeData: prevData,
          loading: false,
          error: errorMessage,
        });
      }

      if (isMultiRoot) {
        buildCombinedTree();
      }
    },
    [workspaceFolders, isMultiRoot, buildCombinedTree]
  );

  // ============================================
  // Load all roots
  // ============================================

  const loadFileTree = useCallback(async () => {
    if (workspaceFolders.length === 0) {
      setTreeError("No workspace folders");
      return;
    }

    setLoadingTree(true);
    setTreeError(null);

    if (!isMultiRoot) {
      const folder = workspaceFolders[0];
      try {
        await ensureGitignoreChecker(folder.path);
        const tree = await loadDirectoryContents(
          folder.path,
          false,
          folder.path
        );
        const prev = fileTreeRef.current;
        const merged =
          prev.length === 0
            ? tree
            : await mergeTreeReloadingExpanded(tree, prev, folder.path);
        setFileTree(merged);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to load file tree";
        setTreeError(errorMessage);
      } finally {
        setLoadingTree(false);
      }
      return;
    }

    // Multi-root: load all in parallel
    const cappedFolders = workspaceFolders.slice(0, MAX_ROOT_TREES);
    await Promise.all(cappedFolders.map((folder) => loadRoot(folder.id)));

    buildCombinedTree();
    setLoadingTree(false);
  }, [
    workspaceFolders,
    isMultiRoot,
    setFileTree,
    setLoadingTree,
    setTreeError,
    loadRoot,
    buildCombinedTree,
  ]);

  // ============================================
  // Toggle directory
  // ============================================

  const toggleDirectory = useCallback(
    async (path: string) => {
      const node = findNodeInTree(fileTreeRef.current, path);
      if (!node || node.type !== "directory") return;

      if (node.expanded) {
        setFileTree((prev) => updateTreeExpansion(prev, path, false));
        return;
      }

      if (!node.children || node.children.length === 0) {
        const rootFolder = findRootForPath(path);
        const rootPath = rootFolder?.path ?? workspaceFolders[0]?.path ?? "";
        try {
          const children = await loadDirectoryContents(path, false, rootPath);
          setFileTree((prev) => updateTreeChildren(prev, path, children));
        } catch (err) {
          log.error("[useMultiRootFileTree] Error loading directory:", {
            path,
            error: err,
          });
          setFileTree((prev) => updateTreeChildren(prev, path, []));
        }
      } else {
        setFileTree((prev) => updateTreeExpansion(prev, path, true));
      }
    },
    [findRootForPath, workspaceFolders, setFileTree]
  );

  // ============================================
  // Collapse all
  // ============================================

  const collapseAll = useCallback(() => {
    const collapseNodes = (nodes: FileNode[]): FileNode[] => {
      return nodes.map((node) => ({
        ...node,
        expanded: false,
        children: node.children ? collapseNodes(node.children) : node.children,
      }));
    };

    if (isMultiRoot) {
      setFileTree((prev) =>
        prev.map((rootNode) => ({
          ...rootNode,
          expanded: false,
          children: rootNode.children
            ? collapseNodes(rootNode.children)
            : rootNode.children,
        }))
      );
    } else {
      setFileTree((prev) => collapseNodes(prev));
    }
  }, [isMultiRoot, setFileTree]);

  // ============================================
  // Reveal file
  // ============================================

  const revealFile = useCallback(
    async (filePath: string) => {
      if (!filePath) return;

      const rootFolder = findRootForPath(filePath);
      const rootPath = rootFolder?.path ?? workspaceFolders[0]?.path ?? "";
      if (!rootPath) return;

      const absolutePath = filePath.startsWith(rootPath)
        ? filePath
        : filePath.startsWith("/")
          ? filePath
          : `${rootPath}/${filePath}`;

      const relativePath = absolutePath.startsWith(rootPath)
        ? absolutePath.slice(rootPath.length).replace(/^\//, "")
        : absolutePath;

      const parts = relativePath.split("/");
      const parentPaths: string[] = [];

      for (let idx = 0; idx < parts.length - 1; idx++) {
        const partialPath = parts.slice(0, idx + 1).join("/");
        parentPaths.push(`${rootPath}/${partialPath}`);
      }

      let localTree = fileTreeRef.current;
      let treeChanged = false;

      for (const dirPath of parentPaths) {
        const dirNode = findNodeInTree(localTree, dirPath);
        if (!dirNode || dirNode.type !== "directory") continue;

        if (!dirNode.expanded) {
          treeChanged = true;
          if (!dirNode.children || dirNode.children.length === 0) {
            try {
              const children = await loadDirectoryContents(
                dirPath,
                false,
                rootPath
              );
              localTree = updateTreeChildren(localTree, dirPath, children);
            } catch (err) {
              log.error("[useMultiRootFileTree] Error revealing file:", {
                dirPath,
                error: err,
              });
            }
          } else {
            localTree = updateTreeExpansion(localTree, dirPath, true);
          }
        }
      }

      if (treeChanged) {
        setFileTree(localTree);
      }

      setSelectedFile(absolutePath);
    },
    [findRootForPath, workspaceFolders, setFileTree, setSelectedFile]
  );

  // ============================================
  // Auto-load on mount
  // ============================================

  useEffect(() => {
    if (autoLoad && workspaceFolders.length > 0) {
      loadFileTree();
    }
  }, [autoLoad, workspaceFolders.length, loadFileTree]);

  // ============================================
  // Auto-refresh on filesystem changes (WebSocket)
  // ============================================
  // Track previous file paths PER REPO to avoid false structural-change
  // detection in multi-root. Without per-repo tracking, alternating events
  // from different repos create an infinite reload loop.

  const MAX_PREV_PATHS_REPOS = 20;
  const previousFilePathsMapRef = useRef<Map<string, Set<string>>>(new Map());
  const treeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  useEffect(() => {
    if (!autoLoad || workspaceFolders.length === 0) return;

    const websocket = getCodeEditorWebSocket();
    if (!websocket) return;

    let mounted = true;

    const unsubscribe = websocket.on("repo:status_updated", (data) => {
      if (!mounted) return;

      const payload = data as {
        repo_id?: string;
        status?: {
          files?: Array<{ path: string; status: string; staged: boolean }>;
          untracked?: number;
        };
      };

      const repoId = payload.repo_id ?? "__unknown__";
      const currentPaths = new Set<string>(
        (payload.status?.files ?? []).map((file) => file.path)
      );

      const prevMap = previousFilePathsMapRef.current;
      const previousPaths = prevMap.get(repoId) ?? new Set();
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

      prevMap.set(repoId, currentPaths);
      if (prevMap.size > MAX_PREV_PATHS_REPOS) {
        const firstKey = prevMap.keys().next().value;
        if (firstKey) prevMap.delete(firstKey);
      }

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
  }, [autoLoad, workspaceFolders.length, loadFileTree]);

  // ============================================
  // Build roots array from ref
  // ============================================

  const roots: RootTree[] = workspaceFolders.map((folder) => {
    const rootTree = rootTreesRef.current.get(folder.id);
    return (
      rootTree ?? {
        folderId: folder.id,
        folderName: folder.name,
        folderPath: folder.path,
        treeData: [],
        loading: false,
        error: null,
      }
    );
  });

  return {
    fileTree,
    roots,
    loadingTree,
    treeError,
    loadFileTree,
    loadRoot,
    toggleDirectory,
    collapseAll,
    revealFile,
  };
}
