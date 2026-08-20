/**
 * useGitDiffState Hook
 *
 * Consolidates git diff related state using useReducer for better
 * performance and predictable state updates.
 *
 * Benefits:
 * - Single state update for related changes (reduces re-renders)
 * - Predictable state transitions
 * - Easier debugging with action types
 */
import { useCallback, useReducer } from "react";

import type { GitFile } from "@src/types/git/types";

// ============================================
// Types
// ============================================

export interface GitDiffState {
  /** Map of file paths to their git file data */
  filesByPath: Map<string, GitFile>;
  /** Set of tab IDs currently showing git diffs */
  openTabs: Set<string>;
  /** Whether diff content is currently loading */
  loading: boolean;
}

export type GitDiffAction =
  | { type: "SET_FILE"; path: string; file: GitFile }
  | {
      type: "SET_FILES";
      files: Map<string, GitFile>;
      /**
       * When provided, the bulk replace only affects files whose `repoRoot`
       * matches this scope (or has no repoRoot, treated as the host repo).
       * Files from *other* worktrees survive — fixes a bug where host repo
       * refreshes wiped out worktree files that had been individually
       * injected via `SET_FILE`.
       */
      scopeRepoRoot?: string;
    }
  | { type: "REMOVE_FILE"; path: string }
  | { type: "CLEAR_FILES" }
  | { type: "ADD_TAB"; tabId: string }
  | { type: "REMOVE_TAB"; tabId: string }
  | { type: "SET_TABS"; tabs: Set<string> }
  | { type: "CLEAR_TABS" }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "BATCH"; actions: GitDiffAction[] };

// ============================================
// Reducer
// ============================================

function areGitFilesEqual(left: GitFile, right: GitFile): boolean {
  return (
    left.id === right.id &&
    left.path === right.path &&
    left.status === right.status &&
    left.staged === right.staged &&
    left.original_path === right.original_path &&
    left.repoRoot === right.repoRoot &&
    left.oldContent === right.oldContent &&
    left.newContent === right.newContent &&
    left.additions === right.additions &&
    left.deletions === right.deletions
  );
}

function areGitFileMapsEqual(
  left: Map<string, GitFile>,
  right: Map<string, GitFile>
): boolean {
  if (left.size !== right.size) return false;
  for (const [path, leftFile] of left) {
    const rightFile = right.get(path);
    if (!rightFile || !areGitFilesEqual(leftFile, rightFile)) return false;
  }
  return true;
}

/**
 * Pure reducer for `useGitDiffState`. Exported so unit tests can pin its
 * scope-aware merge behaviour without going through React.
 */
export function gitDiffReducer(
  state: GitDiffState,
  action: GitDiffAction
): GitDiffState {
  switch (action.type) {
    case "SET_FILE": {
      const newMap = new Map(state.filesByPath);
      const existingFile = state.filesByPath.get(action.path);
      newMap.set(action.path, {
        ...action.file,
        oldContent: action.file.oldContent ?? existingFile?.oldContent,
        newContent: action.file.newContent ?? existingFile?.newContent,
        additions: action.file.additions ?? existingFile?.additions,
        deletions: action.file.deletions ?? existingFile?.deletions,
      });
      return { ...state, filesByPath: newMap };
    }

    case "SET_FILES": {
      const mergedFiles = new Map<string, GitFile>();
      const scope = action.scopeRepoRoot;

      // Carry over files from *other* repo scopes (typically worktrees) so a
      // host-repo refresh doesn't drop worktree-injected entries. Files
      // without a `repoRoot` are assumed to belong to the reporting scope —
      // so they get replaced like the rest.
      if (scope !== undefined) {
        for (const [path, file] of state.filesByPath) {
          const fileScope: string = file.repoRoot ?? scope;
          if (fileScope !== scope) {
            mergedFiles.set(path, file);
          }
        }
      }

      for (const [path, file] of action.files) {
        const existingFile = state.filesByPath.get(path);
        mergedFiles.set(path, {
          ...file,
          repoRoot: file.repoRoot ?? existingFile?.repoRoot ?? scope,
          oldContent: file.oldContent ?? existingFile?.oldContent,
          newContent: file.newContent ?? existingFile?.newContent,
          additions: file.additions ?? existingFile?.additions,
          deletions: file.deletions ?? existingFile?.deletions,
        });
      }

      if (areGitFileMapsEqual(state.filesByPath, mergedFiles)) {
        return state;
      }

      return { ...state, filesByPath: mergedFiles };
    }

    case "REMOVE_FILE": {
      const newMap = new Map(state.filesByPath);
      newMap.delete(action.path);
      return { ...state, filesByPath: newMap };
    }

    case "CLEAR_FILES": {
      return { ...state, filesByPath: new Map() };
    }

    case "ADD_TAB": {
      const newTabs = new Set(state.openTabs);
      newTabs.add(action.tabId);
      return { ...state, openTabs: newTabs };
    }

    case "REMOVE_TAB": {
      const newTabs = new Set(state.openTabs);
      newTabs.delete(action.tabId);
      return { ...state, openTabs: newTabs };
    }

    case "SET_TABS": {
      return { ...state, openTabs: action.tabs };
    }

    case "CLEAR_TABS": {
      return { ...state, openTabs: new Set() };
    }

    case "SET_LOADING": {
      return { ...state, loading: action.loading };
    }

    case "BATCH": {
      // Apply multiple actions in one render
      return action.actions.reduce(gitDiffReducer, state);
    }

    default:
      return state;
  }
}

// ============================================
// Initial State
// ============================================

/**
 * Empty starting state for `useGitDiffState`. Exported for unit-test
 * fixtures.
 */
export const initialGitDiffState: GitDiffState = {
  filesByPath: new Map(),
  openTabs: new Set(),
  loading: false,
};

const initialState = initialGitDiffState;

// ============================================
// Hook
// ============================================

export interface UseGitDiffStateReturn {
  /** Current state */
  state: GitDiffState;

  /** Set a single file's diff data */
  setFile: (path: string, file: GitFile) => void;

  /**
   * Set multiple files at once. When `scopeRepoRoot` is provided, only files
   * belonging to that repo scope are replaced; entries from other worktrees
   * are preserved. Omit it for legacy full-replace behaviour.
   */
  setFiles: (files: Map<string, GitFile>, scopeRepoRoot?: string) => void;

  /** Remove a file from the cache */
  removeFile: (path: string) => void;

  /** Clear all cached files */
  clearFiles: () => void;

  /** Add a tab to the open set */
  addTab: (tabId: string) => void;

  /** Remove a tab from the open set */
  removeTab: (tabId: string) => void;

  /** Set all open tabs */
  setTabs: (tabs: Set<string>) => void;

  /** Clear all tabs */
  clearTabs: () => void;

  /** Set loading state */
  setLoading: (loading: boolean) => void;

  /** Batch update: set file and add tab in one render */
  openDiffTab: (path: string, file: GitFile, tabId: string) => void;

  /** Batch update: start loading, then set file */
  loadFile: (path: string, loadFn: () => Promise<GitFile>) => Promise<void>;
}

export function useGitDiffState(): UseGitDiffStateReturn {
  const [state, dispatch] = useReducer(gitDiffReducer, initialState);

  // Simple actions
  const setFile = useCallback((path: string, file: GitFile) => {
    dispatch({ type: "SET_FILE", path, file });
  }, []);

  const setFiles = useCallback(
    (files: Map<string, GitFile>, scopeRepoRoot?: string) => {
      dispatch({ type: "SET_FILES", files, scopeRepoRoot });
    },
    []
  );

  const removeFile = useCallback((path: string) => {
    dispatch({ type: "REMOVE_FILE", path });
  }, []);

  const clearFiles = useCallback(() => {
    dispatch({ type: "CLEAR_FILES" });
  }, []);

  const addTab = useCallback((tabId: string) => {
    dispatch({ type: "ADD_TAB", tabId });
  }, []);

  const removeTab = useCallback((tabId: string) => {
    dispatch({ type: "REMOVE_TAB", tabId });
  }, []);

  const setTabs = useCallback((tabs: Set<string>) => {
    dispatch({ type: "SET_TABS", tabs });
  }, []);

  const clearTabs = useCallback(() => {
    dispatch({ type: "CLEAR_TABS" });
  }, []);

  const setLoading = useCallback((loading: boolean) => {
    dispatch({ type: "SET_LOADING", loading });
  }, []);

  // Batch actions for common patterns
  const openDiffTab = useCallback(
    (path: string, file: GitFile, tabId: string) => {
      dispatch({
        type: "BATCH",
        actions: [
          { type: "SET_FILE", path, file },
          { type: "ADD_TAB", tabId },
          { type: "SET_LOADING", loading: false },
        ],
      });
    },
    []
  );

  const loadFile = useCallback(
    async (path: string, loadFn: () => Promise<GitFile>) => {
      dispatch({ type: "SET_LOADING", loading: true });
      try {
        const file = await loadFn();
        dispatch({
          type: "BATCH",
          actions: [
            { type: "SET_FILE", path, file },
            { type: "SET_LOADING", loading: false },
          ],
        });
      } catch {
        dispatch({ type: "SET_LOADING", loading: false });
        throw new Error(`Failed to load diff for ${path}`);
      }
    },
    []
  );

  return {
    state,
    setFile,
    setFiles,
    removeFile,
    clearFiles,
    addTab,
    removeTab,
    setTabs,
    clearTabs,
    setLoading,
    openDiffTab,
    loadFile,
  };
}

export default useGitDiffState;
