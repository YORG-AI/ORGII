/**
 * useCodeEditorHandlers Hook
 *
 * Extracts and memoizes event handlers for CodeEditor component.
 * This improves performance by:
 * - Reducing component complexity
 * - Preventing unnecessary re-renders
 * - Making handler dependencies explicit
 */
import { useSetAtom } from "jotai";
import { useCallback } from "react";

import { getGitFileContent } from "@src/api/http/git/diff";
import Message from "@src/components/Message";
import { useGitStatus } from "@src/contexts/git";
import { createLogger } from "@src/hooks/logger";
import {
  type PanelState,
  createFileTab,
  createTimelineDiffTab,
  openTab,
  requestTabScrollRevealAtom,
} from "@src/store/workstation/tabs";
import type { GitFile } from "@src/types/git/types";

import type { UseGitDiffStateReturn } from "../git/useGitDiffState";
import type { UseCodeEditorReturn } from "../useCodeEditor";

const logger = createLogger("CodeEditorHandlers");

// ============================================
// Types
// ============================================

export interface UseCodeEditorHandlersOptions {
  repoPath: string;
  repoName: string;
  editorState: UseCodeEditorReturn;
  setPrimaryPanel: (fn: (prev: PanelState) => PanelState) => void;
  setSearchPanelVisible: (visible: boolean) => void;
  gitDiffState: UseGitDiffStateReturn;
}

export interface UseCodeEditorHandlersReturn {
  // File handlers
  handleFileSelect: (path: string) => void;
  handleFileSelectWithLine: (path: string, line: number) => void;
  handleContentChange: (content: string) => void;
  handleSave: () => Promise<void>;
  handleDiscard: () => void;
  handleDirectoryToggle: (path: string) => void;

  // Search handlers
  handleSearchClick: () => void;
  handleSearchClose: () => void;
  handleSearchChange: (query: string) => void;
  handleSearchFileSelect: (path: string) => void;
  handleFilterSearch: (query: string) => void;
  handleClearFilterSearch: () => void;

  // Git handlers
  handleGitFileSelect: (file: GitFile) => void;
  handleTimelineCommitClick: (
    commitSha: string,
    filePath: string,
    commitInfo?: {
      sha: string;
      shortSha: string;
      message: string;
      author: string;
      timestamp: string;
    }
  ) => Promise<void>;
}

// ============================================
// Hook
// ============================================

export function useCodeEditorHandlers(
  options: UseCodeEditorHandlersOptions
): UseCodeEditorHandlersReturn {
  const {
    repoPath,
    repoName: _repoName,
    editorState,
    setPrimaryPanel,
    setSearchPanelVisible,
    gitDiffState,
  } = options;

  const requestScrollReveal = useSetAtom(requestTabScrollRevealAtom);
  // Git status context for triggering immediate refresh after save
  const { forceRefresh } = useGitStatus();

  // ============================================
  // File Handlers
  // ============================================

  // File selection from tree
  const handleFileSelect = useCallback(
    (path: string) => {
      editorState.selectFile(path);

      const tab = createFileTab(path);
      setPrimaryPanel((prev) => openTab(prev, tab));

      requestScrollReveal(tab.id);

      // Remove from git diff tabs if it was there
      gitDiffState.removeTab(path);
    },
    [editorState, setPrimaryPanel, gitDiffState, requestScrollReveal]
  );

  // File selection with line navigation (e.g., from search results)
  const handleFileSelectWithLine = useCallback(
    (path: string, line: number) => {
      editorState.selectFile(path);

      const tab = createFileTab(path, line);
      setPrimaryPanel((prev) => openTab(prev, tab));

      requestScrollReveal(tab.id);

      // Remove from git diff tabs if it was there
      gitDiffState.removeTab(path);
    },
    [editorState, setPrimaryPanel, gitDiffState, requestScrollReveal]
  );

  // Content change in editor
  const handleContentChange = useCallback(
    (content: string) => {
      editorState.updateFileContent(content);
    },
    [editorState]
  );

  // Save file
  const handleSave = useCallback(async () => {
    if (!editorState.selectedFile || !editorState.hasUnsavedChanges) return;

    const success = await editorState.saveFileContent(
      editorState.selectedFile,
      editorState.fileContent
    );

    if (success) {
      // Trigger immediate git status refresh (bypasses debouncing)
      forceRefresh();
    }
  }, [editorState, forceRefresh]);

  // Discard changes
  const handleDiscard = useCallback(() => {
    editorState.discardChanges();
  }, [editorState]);

  // Directory toggle from tree
  const handleDirectoryToggle = useCallback(
    (path: string) => {
      editorState.toggleDirectory(path);
    },
    [editorState]
  );

  // ============================================
  // Search Handlers
  // ============================================

  const handleSearchClick = useCallback(() => {
    setSearchPanelVisible(true);
  }, [setSearchPanelVisible]);

  const handleSearchClose = useCallback(() => {
    setSearchPanelVisible(false);
    editorState.clearSearch();
  }, [setSearchPanelVisible, editorState]);

  const handleSearchChange = useCallback(
    (query: string) => {
      editorState.searchFiles(query);
    },
    [editorState]
  );

  // File selection from search
  const handleSearchFileSelect = useCallback(
    (path: string) => {
      editorState.selectFile(path);

      const tab = createFileTab(path);
      setPrimaryPanel((prev) => openTab(prev, tab));
    },
    [editorState, setPrimaryPanel]
  );

  const handleFilterSearch = useCallback(
    (query: string) => {
      editorState.searchFiles(query);
    },
    [editorState]
  );

  const handleClearFilterSearch = useCallback(() => {
    editorState.clearSearch();
  }, [editorState]);

  // ============================================
  // Git Handlers
  // ============================================

  // Git file selection from Source Control sidebar — drives the unified
  // Source Control tab into Focus mode on the clicked file. Never spawns
  // a standalone git-diff tab anymore (that surface is reserved for
  // Timeline / commit-detail snapshots).
  const handleGitFileSelect = useCallback(
    (file: GitFile) => {
      // Use the file's own repoRoot (set for worktree files) or fall back to
      // the host repo path. This ensures worktree diffs are fetched from the
      // correct worktree directory rather than the main repo.
      const effectiveRepoPath = file.repoRoot ?? repoPath;

      const absolutePath = file.path.startsWith("/")
        ? file.path
        : `${effectiveRepoPath}/${file.path}`;
      const relativePath = file.path.startsWith(effectiveRepoPath)
        ? file.path.slice(effectiveRepoPath.length + 1)
        : file.path;

      setPrimaryPanel((prev) => {
        const tabIndex = prev.tabs.findIndex(
          (item) => item.type === "source-control"
        );
        if (tabIndex === -1) {
          // Pinned tab is missing (shouldn't happen) — leave state untouched.
          return prev;
        }
        const existing = prev.tabs[tabIndex];
        const nextTabs = [...prev.tabs];
        nextTabs[tabIndex] = {
          ...existing,
          data: {
            ...existing.data,
            mode: "focus",
            focusPath: absolutePath,
            historySelection: null,
          },
        };
        return { tabs: nextTabs, activeTabId: existing.id };
      });

      // Store the diff under the SAME key (`relativePath`) that
      // `useGitFiles` writes when git-status refreshes. Otherwise the next
      // git-status poll's `SET_FILES` action wipes our absolute-path entry
      // and the focused diff blanks out for one render — visible as the
      // "diff appears then disappears" flash on the Source Control tab.
      gitDiffState.setFile(relativePath, {
        ...file,
        path: relativePath,
        repoRoot: effectiveRepoPath,
      });
      gitDiffState.addTab(relativePath);

      // The visible GitDiffContent owns loading the body. Selection only
      // publishes metadata so a click cannot race a second full-diff request.
      gitDiffState.setLoading(false);
    },
    [repoPath, setPrimaryPanel, gitDiffState]
  );

  // Timeline commit selection
  const handleTimelineCommitClick = useCallback(
    async (
      commitSha: string,
      filePath: string,
      commitInfo?: {
        sha: string;
        shortSha: string;
        message: string;
        author: string;
        timestamp: string;
      }
    ) => {
      try {
        gitDiffState.setLoading(true);

        let relativeFilePath = filePath;
        if (filePath.startsWith(repoPath)) {
          relativeFilePath = filePath.slice(repoPath.length);
          if (relativeFilePath.startsWith("/")) {
            relativeFilePath = relativeFilePath.slice(1);
          }
        }

        const parentRef = `${commitSha}^`;

        const [oldContentResult, newContentResult] = await Promise.all([
          getGitFileContent({
            repo_id: repoPath,
            file_path: relativeFilePath,
            ref: parentRef,
          }),
          getGitFileContent({
            repo_id: repoPath,
            file_path: relativeFilePath,
            ref: commitSha,
          }),
        ]);

        if (!newContentResult) {
          gitDiffState.setLoading(false);
          Message.warning(
            "Cannot show diff: file may not exist at this commit"
          );
          return;
        }

        const gitFile: GitFile = {
          id: `timeline:${commitSha}:${filePath}`,
          path: filePath,
          status: oldContentResult ? "modified" : "added",
          additions: 0,
          deletions: 0,
          oldContent: oldContentResult?.content || "",
          newContent: newContentResult.content,
          staged: false,
        };

        const parentShortSha = oldContentResult
          ? commitSha.substring(0, 7) + "^"
          : "∅";
        const shortSha = commitSha.substring(0, 7);
        const tab = createTimelineDiffTab(
          filePath,
          commitSha,
          parentShortSha,
          shortSha,
          commitInfo
        );

        setPrimaryPanel((prev) => openTab(prev, tab));

        gitDiffState.setFile(tab.id, gitFile);
        gitDiffState.addTab(tab.id);
        gitDiffState.setLoading(false);
      } catch (error) {
        logger.error("Error opening timeline diff:", error);
        Message.error("Failed to open timeline diff");
        gitDiffState.setLoading(false);
      }
    },
    [repoPath, setPrimaryPanel, gitDiffState]
  );

  return {
    // File
    handleFileSelect,
    handleFileSelectWithLine,
    handleContentChange,
    handleSave,
    handleDiscard,
    handleDirectoryToggle,

    // Search
    handleSearchClick,
    handleSearchClose,
    handleSearchChange,
    handleSearchFileSelect,
    handleFilterSearch,
    handleClearFilterSearch,

    // Git
    handleGitFileSelect,
    handleTimelineCommitClick,
  };
}

export default useCodeEditorHandlers;
