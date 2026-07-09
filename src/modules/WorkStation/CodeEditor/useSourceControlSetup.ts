import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { GitWorktreeEntry } from "@src/api/http/git/types";
import { useGitStatus } from "@src/contexts/git";
import { useRepoGitInitialization } from "@src/hooks/git";
import { useGitFiles } from "@src/hooks/git/sourceControl";
import { createLogger } from "@src/hooks/logger";
import { loadGitFileDiffContent } from "@src/hooks/workStation/editor/gitDiffContent";
import type { UseGitDiffStateReturn } from "@src/hooks/workStation/git/useGitDiffState";
import {
  sourceControlFilterModeAtom,
  sourceControlFilterModeHandlerAtom,
  sourceControlFocusTargetAtom,
} from "@src/store/workstation/codeEditor";
import {
  workstationPrCommitMessageAtomFamily,
  workstationRepoScopeKey,
} from "@src/store/workstation/codeEditor/workstationPrAtom";
import type {
  PanelState,
  SourceControlHistorySelection,
} from "@src/store/workstation/tabs";
import type { WorkStationTab } from "@src/store/workstation/tabs/types";
import type { GitFile } from "@src/types/git/types";

import {
  type SourceControlFilterCounts,
  SourceControlFilterHeader,
  type SourceControlFilterMode,
} from "../shared/SidebarModules";
import { confirmAndRemoveWorktree } from "./Panels/EditorPrimarySidebar/content/worktreeRemoveActions";
import { useGitWorktrees } from "./Panels/EditorPrimarySidebar/hooks/useGitWorktrees";
import { useSourceControlScope } from "./Panels/EditorPrimarySidebar/hooks/useSourceControlScope";
import { useWorkstationPr } from "./Panels/EditorPrimarySidebar/hooks/useWorkstationPr";
import { SourceControlScopeToolbar } from "./Panels/EditorPrimarySidebar/tabs/SourceControlScopeToolbar";
import {
  type ScopePickerWorktreeEntry,
  resolveScopeRepoRoot,
} from "./Panels/EditorPrimarySidebar/tabs/sourceControlScopePickerHelpers";
import { resolveGitDiffSelection } from "./sourceControlSelection";
import { useStashCount } from "./useStashCount";

const logger = createLogger("SourceControlSetup");

interface UseSourceControlSetupParams {
  repoPath: string;
  repoId: string | null;
  currentBranch: string | undefined;
  gitDiffState: UseGitDiffStateReturn;
  activeTab: WorkStationTab | undefined | null;
  setPrimaryPanel: (updater: (prev: PanelState) => PanelState) => void;
  handleGitFileSelect: (file: GitFile) => void;
  isMultiRoot?: boolean;
}

export interface UseSourceControlSetupReturn {
  sourceControlFilterMode: SourceControlFilterMode;
  sourceControlFilterCounts: SourceControlFilterCounts;
  sourceControlHeaderFilter: React.ReactNode;
  sourceControlHeaderScopePicker: React.ReactNode;
  tabSidebarExtraContext: {
    surface: {
      sourceControl: {
        filterMode: SourceControlFilterMode;
        navigateWithoutSelecting: boolean;
      };
    };
  };
  handleGitFilesChange: (files: GitFile[], scopeRepoRoot?: string) => void;
  handleSourceControlHistorySelectionChange: (
    selection: SourceControlHistorySelection
  ) => void;
  handleDiffSidebarFileSelect: (file: GitFile) => void;
}

export function useSourceControlSetup({
  repoPath,
  repoId,
  currentBranch,
  gitDiffState,
  activeTab,
  setPrimaryPanel,
  handleGitFileSelect,
  isMultiRoot = false,
}: UseSourceControlSetupParams): UseSourceControlSetupReturn {
  const { t } = useTranslation();
  const setSourceControlFocusTarget = useSetAtom(sourceControlFocusTargetAtom);
  const [sourceControlFilterMode, setSourceControlFilterMode] = useAtom(
    sourceControlFilterModeAtom
  );

  const { isGitInitialized } = useRepoGitInitialization(repoPath);
  const resolvedRepoId = repoId ?? repoPath;
  const isSourceControlActive = activeTab?.type === "source-control";
  const {
    worktrees,
    mainDiffSummary,
    hasWorktrees,
    loading: worktreesLoading,
    refresh: refreshWorktrees,
  } = useGitWorktrees({
    repoId: resolvedRepoId,
    repoPath,
    enabled: isGitInitialized === true && isSourceControlActive,
  });
  const { scope, setScope } = useSourceControlScope({
    repoPath,
    worktrees,
    enabled: isGitInitialized === true && hasWorktrees,
    worktreesReady: !worktreesLoading,
  });

  const repoName = useMemo(() => {
    const segments = repoPath.replace(/\/+$/, "").split("/");
    return segments[segments.length - 1] || "Repository";
  }, [repoPath]);

  // PR state — this is the SINGLE mount of useWorkstationPr. It runs at the
  // CodeEditor level so eligibility/create callbacks stay available regardless
  // of which sidebar tab is active. The open PR list is still loaded lazily by
  // PullRequestContent when the PR page is visited.
  const { currentGitStatus: gitStatus } = useGitStatus();
  const hasUpstream = !!gitStatus?.current_upstream_branch;
  const { files: gitFilesForPr } = useGitFiles({
    selectedRepoId: repoId,
    repoPath,
    autoLoad: true,
  });
  const scopeKey = workstationRepoScopeKey(repoId, repoPath);
  const workstationPrCommitMessage = useAtomValue(
    workstationPrCommitMessageAtomFamily(scopeKey)
  );
  useWorkstationPr({
    repoPath,
    repoId: repoId ?? undefined,
    branchName: currentBranch,
    hasUpstream,
    uncommittedCount: gitFilesForPr.length,
    commitMessage: workstationPrCommitMessage,
  });

  const { filesByPath: gitFilesByPath } = gitDiffState.state;
  const clearGitDiffFiles = gitDiffState.clearFiles;

  useEffect(() => {
    clearGitDiffFiles();
    setSourceControlFocusTarget(null);
  }, [clearGitDiffFiles, repoId, repoPath, setSourceControlFocusTarget]);

  const sourceControlFileCounts = useMemo<
    Pick<SourceControlFilterCounts, "uncommitted" | "unstaged" | "staged">
  >(() => {
    if (!repoPath) {
      return { uncommitted: 0, unstaged: 0, staged: 0 };
    }
    const activeRepoRoot = resolveScopeRepoRoot(scope, repoPath);
    const files = Array.from(gitFilesByPath.values()).filter(
      (file) => (file.repoRoot ?? repoPath) === activeRepoRoot
    );
    const staged = files.filter((file) => file.staged).length;
    return {
      uncommitted: files.length,
      unstaged: files.length - staged,
      staged,
    };
  }, [gitFilesByPath, repoPath, scope]);

  const sourceControlStashCount = useStashCount({
    repoPath,
    repoId: repoId ?? undefined,
  });

  const sourceControlFilterCounts = useMemo<SourceControlFilterCounts>(
    () => ({
      ...sourceControlFileCounts,
      stashed: sourceControlStashCount,
    }),
    [sourceControlFileCounts, sourceControlStashCount]
  );

  const handleSourceControlHeaderRefresh = useCallback(() => {}, []);

  const handleSourceControlFilterModeChange = useCallback(
    (mode: SourceControlFilterMode) => {
      setSourceControlFilterMode(mode);
      if (mode === "history" || mode === "pr" || mode === "issues") return;
      setPrimaryPanel((prev: PanelState) => {
        const tabIndex = prev.tabs.findIndex(
          (item) => item.type === "source-control"
        );
        if (tabIndex === -1) return prev;
        const existing = prev.tabs[tabIndex];
        const nextStaged = mode === "staged";
        const nextFileCount = sourceControlFilterCounts[mode];
        const shouldUpdateStaged = existing.data.staged !== nextStaged;
        const shouldUpdateFileCount = existing.data.fileCount !== nextFileCount;
        const shouldClearHistory = Boolean(existing.data.historySelection);
        if (
          !shouldUpdateStaged &&
          !shouldUpdateFileCount &&
          !shouldClearHistory
        ) {
          return prev;
        }
        const nextTabs = [...prev.tabs];
        nextTabs[tabIndex] = {
          ...existing,
          data: {
            ...existing.data,
            staged: nextStaged,
            fileCount: nextFileCount,
            historySelection: null,
          },
        };
        return { ...prev, tabs: nextTabs };
      });
    },
    [setPrimaryPanel, setSourceControlFilterMode, sourceControlFilterCounts]
  );

  const setSourceControlFilterModeHandler = useSetAtom(
    sourceControlFilterModeHandlerAtom
  );
  useEffect(() => {
    setSourceControlFilterModeHandler(
      () => handleSourceControlFilterModeChange
    );
    return () => setSourceControlFilterModeHandler(null);
  }, [handleSourceControlFilterModeChange, setSourceControlFilterModeHandler]);

  const sourceControlHeaderFilter = useMemo(
    () =>
      React.createElement(SourceControlFilterHeader, {
        mode: sourceControlFilterMode,
        onChangeMode: handleSourceControlFilterModeChange,
        onRefresh: handleSourceControlHeaderRefresh,
        showRefresh: false,
        counts: sourceControlFilterCounts,
      }),
    [
      handleSourceControlFilterModeChange,
      handleSourceControlHeaderRefresh,
      sourceControlFilterCounts,
      sourceControlFilterMode,
    ]
  );

  const showScopePicker =
    activeTab?.type === "source-control" &&
    hasWorktrees &&
    !isMultiRoot &&
    sourceControlFilterMode !== "history" &&
    sourceControlFilterMode !== "pr" &&
    sourceControlFilterMode !== "issues";

  const handleRemoveWorktree = useCallback(
    async (worktree: ScopePickerWorktreeEntry) => {
      const folderName = worktree.path.split("/").pop() || "worktree";
      const removed = await confirmAndRemoveWorktree({
        repoId: resolvedRepoId,
        repoPath,
        worktree: worktree as GitWorktreeEntry,
        folderName,
        onRemoved: refreshWorktrees,
        t,
      });
      if (!removed) return;
      if (scope.kind === "worktree" && scope.path === worktree.path) {
        setScope({ kind: "local" });
      }
    },
    [repoPath, refreshWorktrees, resolvedRepoId, scope, setScope, t]
  );

  const sourceControlHeaderScopePicker = useMemo(() => {
    if (!showScopePicker) return null;
    return React.createElement(SourceControlScopeToolbar, {
      repoName,
      branchLabel: currentBranch || repoName,
      repoPath,
      localDiffSummary: mainDiffSummary,
      worktrees,
      scope,
      onScopeChange: setScope,
      onRemoveWorktree: handleRemoveWorktree,
    });
  }, [
    currentBranch,
    handleRemoveWorktree,
    mainDiffSummary,
    repoName,
    repoPath,
    scope,
    setScope,
    showScopePicker,
    worktrees,
  ]);

  const isSourceControlAllChangesActive =
    activeTab?.type === "source-control" &&
    activeTab.data.mode === "all-changes";

  const tabSidebarExtraContext = useMemo(
    () => ({
      surface: {
        sourceControl: {
          filterMode: sourceControlFilterMode,
          navigateWithoutSelecting: isSourceControlAllChangesActive,
          worktrees,
          hasWorktrees,
          worktreesLoading,
          refreshWorktrees,
        },
      },
    }),
    [
      hasWorktrees,
      isSourceControlAllChangesActive,
      refreshWorktrees,
      sourceControlFilterMode,
      worktrees,
      worktreesLoading,
    ]
  );

  const handleSourceControlHistorySelectionChange = useCallback(
    (selection: SourceControlHistorySelection) => {
      setPrimaryPanel((prev: PanelState) => {
        const tabIndex = prev.tabs.findIndex(
          (item) => item.type === "source-control"
        );
        if (tabIndex === -1) return prev;
        const existing = prev.tabs[tabIndex];
        const nextTabs = [...prev.tabs];
        nextTabs[tabIndex] = {
          ...existing,
          data: { ...existing.data, historySelection: selection },
        };
        return {
          tabs: nextTabs,
          activeTabId:
            prev.activeTabId === existing.id ? existing.id : prev.activeTabId,
        };
      });
    },
    [setPrimaryPanel]
  );

  const setGitDiffFiles = gitDiffState.setFiles;
  const handleGitFilesChange = useCallback(
    (files: GitFile[], scopeRepoRoot?: string) => {
      const filesMap = new Map(files.map((file) => [file.path, file]));
      setGitDiffFiles(filesMap, scopeRepoRoot);
    },
    [setGitDiffFiles]
  );

  // `handleDiffSidebarFileSelect` is consumed by the memoized SidebarSlot
  // context. Reading `activeTab` and `handleGitFileSelect` through refs keeps
  // the callback identity stable across navigation so the warm Source Control
  // tree does not re-render on every tab switch. (`handleGitFileSelect` is not
  // stable on its own — it closes over the per-render `gitDiffState` object.)
  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  const handleGitFileSelectRef = useRef(handleGitFileSelect);
  useEffect(() => {
    handleGitFileSelectRef.current = handleGitFileSelect;
  }, [handleGitFileSelect]);

  const setGitDiffFile = gitDiffState.setFile;
  const handleDiffSidebarFileSelect = useCallback(
    (file: GitFile) => {
      const {
        effectiveRepoPath,
        absolutePath,
        relativePath,
        isAllChangesView,
      } = resolveGitDiffSelection(file, repoPath, activeTabRef.current);

      if (!isAllChangesView) {
        handleGitFileSelectRef.current(file);
        return;
      }

      setGitDiffFile(relativePath, {
        ...file,
        path: relativePath,
        repoRoot: effectiveRepoPath,
      });
      setSourceControlFocusTarget({ path: absolutePath, nonce: Date.now() });

      if (file.oldContent !== undefined || !effectiveRepoPath) return;

      loadGitFileDiffContent({
        repoPath: effectiveRepoPath,
        file,
        relativePath,
      })
        .then((diffFile) => {
          if (!diffFile) return;
          setGitDiffFile(relativePath, diffFile);
        })
        .catch((error) => {
          logger.error("Failed to load git diff:", error);
        });
    },
    [repoPath, setGitDiffFile, setSourceControlFocusTarget]
  );

  return {
    sourceControlFilterMode,
    sourceControlFilterCounts,
    sourceControlHeaderFilter,
    sourceControlHeaderScopePicker,
    tabSidebarExtraContext,
    handleGitFilesChange,
    handleSourceControlHistorySelectionChange,
    handleDiffSidebarFileSelect,
  };
}
