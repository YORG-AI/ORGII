/**
 * useTargetDirectory Hook
 *
 * Determines the target directory for new file/folder creation.
 * VS Code behavior: if a file is selected, use its parent; if a folder, use that folder.
 *
 * Extracted from EditorPrimarySidebar.
 */
import { useCallback } from "react";

import type { FileNode } from "@src/modules/WorkStation/CodeEditor/hooks/useCodeEditor";

export interface UseTargetDirectoryOptions {
  repoPath: string;
  /** The effective selected path (file or folder) */
  effectiveSelectedPath: string | null;
  /** The explicitly selected folder path */
  selectedFolderPath: string | null;
  /** The file tree to search for node types */
  fileTree: FileNode[];
}

export function useTargetDirectory({
  repoPath,
  effectiveSelectedPath,
  selectedFolderPath,
  fileTree,
}: UseTargetDirectoryOptions): () => string | null {
  return useCallback((): string | null => {
    if (!repoPath) return null;

    // No selection - use repo root
    if (!effectiveSelectedPath) return repoPath;

    // If folder is explicitly selected, use it directly
    if (selectedFolderPath) {
      return selectedFolderPath;
    }

    // Find the selected node in tree to check if it's a directory
    const findNode = (
      nodes: FileNode[],
      path: string
    ): FileNode | undefined => {
      for (const node of nodes) {
        if (node.path === path) return node;
        if (node.children) {
          const found = findNode(node.children, path);
          if (found) return found;
        }
      }
      return undefined;
    };

    const selectedNode = findNode(fileTree, effectiveSelectedPath);

    if (selectedNode?.type === "directory") {
      return effectiveSelectedPath;
    } else {
      // Selected a file - create in its parent directory
      const lastSlash = effectiveSelectedPath.lastIndexOf("/");
      return lastSlash > 0
        ? effectiveSelectedPath.substring(0, lastSlash)
        : repoPath;
    }
  }, [repoPath, effectiveSelectedPath, selectedFolderPath, fileTree]);
}
