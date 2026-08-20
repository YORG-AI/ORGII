/**
 * useCodeEditor Hook
 *
 * Business logic for the Workstation CodeEditor: file tree, read/save, and search.
 * Uses Tauri filesystem APIs for direct workspace access.
 *
 * State is unified via Jotai atoms - both this hook and FileService operate
 * on the same state. This enables AI actions to be visible in UI and vice versa.
 *
 * Performance optimizations:
 * - Fine-grained atoms prevent unnecessary re-renders
 * - useAtomValue for read-only subscriptions
 * - useSetAtom for write-only operations
 *
 * Split into sub-hooks:
 * - useFileTree: File tree loading, expansion, reveal, auto-refresh
 * - useFileContent: File content loading, saving, unsaved changes
 * - useFileSearch: File searching with deferred results
 */
import { useAtom, useSetAtom } from "jotai";
import { startTransition, useCallback, useEffect, useMemo } from "react";

import {
  fileClearSearchAtom,
  fileRepoPathAtom,
  fileSelectedPathAtom,
} from "@src/store/workstation/codeEditor/file";

import type { UseCodeEditorOptions, UseCodeEditorReturn } from "./types";
import { useFileContent } from "./useFileContent";
import { useFileSearch } from "./useFileSearch";
import { useFileTree } from "./useFileTree";
import { useMultiRootFileTree } from "./useMultiRootFileTree";

// Re-export types for consumers
export type { FileNode, FileSearchResult } from "./types";
export type { UseCodeEditorOptions, UseCodeEditorReturn } from "./types";

// ============================================
// Hook
// ============================================

export function useCodeEditor(
  options: UseCodeEditorOptions
): UseCodeEditorReturn {
  const {
    repoPath,
    repoId: _repoId,
    autoLoad = true,
    workspaceFolders,
  } = options;

  // ============================================
  // Shared state
  // ============================================
  const [selectedFile, setSelectedFile] = useAtom(fileSelectedPathAtom);
  const setRepoPath = useSetAtom(fileRepoPathAtom);
  const clearSearchAction = useSetAtom(fileClearSearchAtom);

  // Set repo path on mount
  useEffect(() => {
    if (repoPath) {
      setRepoPath(repoPath);
    }
  }, [repoPath, setRepoPath]);

  // ============================================
  // Sub-hooks
  // ============================================
  const isMultiRoot =
    workspaceFolders !== undefined && workspaceFolders.length > 1;

  const singleRootTree = useFileTree(repoPath, autoLoad && !isMultiRoot);
  const multiRootTree = useMultiRootFileTree(
    workspaceFolders ?? [],
    autoLoad && isMultiRoot
  );

  const {
    fileTree,
    loadingTree,
    treeError,
    loadFileTree,
    toggleDirectory,
    collapseAll,
    revealFile,
  } = isMultiRoot ? multiRootTree : singleRootTree;

  const {
    fileContent,
    loadingContent,
    contentError,
    saveError,
    saving,
    hasUnsavedChanges,
    isBinary,
    loadFileContent,
    saveFileContent,
    updateFileContent,
    markSaved,
    discardChanges,
  } = useFileContent();

  const {
    searchQuery,
    searchResults,
    searchLoading,
    searchError,
    searchFiles,
    clearSearch,
  } = useFileSearch(repoPath);

  // ============================================
  // Combined state
  // ============================================
  const loading = loadingTree || loadingContent || searchLoading;

  // ============================================
  // Cross-domain actions
  // ============================================

  /**
   * Select a file and load its content
   *
   * PERFORMANCE: Uses startTransition to mark file content loading as non-urgent.
   * This allows React to prioritize user interactions (like click feedback)
   * over the content loading which can be deferred.
   */
  const selectFile = useCallback(
    (path: string) => {
      setSelectedFile(path);
      startTransition(() => {
        loadFileContent(path);
      });
    },
    [setSelectedFile, loadFileContent]
  );

  /**
   * Refresh the entire editor state (tree, content, search)
   */
  const refresh = useCallback(async () => {
    setSelectedFile(null);
    updateFileContent("");
    clearSearchAction();
    await loadFileTree();
  }, [setSelectedFile, updateFileContent, clearSearchAction, loadFileTree]);

  // ============================================
  // Standardized actions interface for dispatcher integration
  // ============================================
  const actions = useMemo(
    () => ({
      open: selectFile,
      save: saveFileContent,
      reveal: revealFile,
      search: searchFiles,
      refresh,
      discard: discardChanges,
    }),
    [
      selectFile,
      saveFileContent,
      revealFile,
      searchFiles,
      refresh,
      discardChanges,
    ]
  );

  // ============================================
  // Memoized return
  // ============================================
  return useMemo(
    () => ({
      // State
      selectedFile,
      fileTree,
      searchQuery,
      searchResults,
      fileContent,
      loading,
      treeError,
      contentError,
      searchError,
      saveError,
      loadingTree,
      loadingContent,
      searchLoading,
      saving,
      hasUnsavedChanges,
      isBinary,

      // Actions
      loadFileTree,
      loadFileContent,
      saveFileContent,
      selectFile,
      searchFiles,
      toggleDirectory,
      clearSearch,
      refresh,
      collapseAll,
      updateFileContent,
      markSaved,
      discardChanges,
      revealFile,

      // Standardized actions sub-object
      actions,
    }),
    [
      selectedFile,
      fileTree,
      searchQuery,
      searchResults,
      fileContent,
      loading,
      treeError,
      contentError,
      searchError,
      saveError,
      loadingTree,
      loadingContent,
      searchLoading,
      saving,
      hasUnsavedChanges,
      isBinary,
      loadFileTree,
      loadFileContent,
      saveFileContent,
      selectFile,
      searchFiles,
      toggleDirectory,
      clearSearch,
      refresh,
      collapseAll,
      updateFileContent,
      markSaved,
      discardChanges,
      revealFile,
      actions,
    ]
  );
}
