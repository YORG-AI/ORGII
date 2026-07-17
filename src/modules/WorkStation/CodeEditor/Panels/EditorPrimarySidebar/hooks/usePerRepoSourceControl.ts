/**
 * usePerRepoSourceControl
 *
 * Self-contained source control hook for a specific repo path.
 * Unlike useSourceControlState (which reads from global gitStatusAtom),
 * this hook fetches git status directly via Tauri invoke for the given repo.
 *
 * Performance:
 * - Ref-based file access for callbacks — prevents callback cascade on file changes
 * - Debounced WebSocket refresh via useDebouncedCallback — coalesces rapid status events
 * - Separate initialLoading vs background refresh — no spinner flash on updates
 * - Stable callback references — minimizes SourceControlContent re-renders
 *
 * Encapsulation:
 * - createScopedGitApi — binds repo_id/repo_path once for all git operations
 * - confirmDestructiveAction — unified discard confirmation dialog
 * - useDebouncedCallback — replaces hand-rolled debounce timer
 */
import { remove } from "@tauri-apps/plugin-fs";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GitWorkingDirectoryFile } from "@src/api/http/git";
import { fetchNumstatMap } from "@src/api/http/git/diff";
import {
  type ScopedGitApi,
  createScopedGitApi,
} from "@src/api/http/git/scopedGitApi";
import { getGitStatus } from "@src/api/http/git/status";
import type { GitStatusData } from "@src/api/http/git/types";
import { normalizeGitStatus } from "@src/config/gitStatus";
import { useFileSelection } from "@src/hooks/git/sourceControl";
import { generateCommitMessage } from "@src/hooks/git/sourceControl/commitMessageGeneration";
import { useRepoStatusListener } from "@src/hooks/git/useRepoStatusListener";
import { useMounted } from "@src/hooks/lifecycle/useMounted";
import { createLogger } from "@src/hooks/logger";
import {
  DEBOUNCE_DELAYS,
  useDebouncedCallback,
} from "@src/hooks/perf/useDebouncedCallback";
import { gitCommitInstructionsAtom } from "@src/store/ui/editorSettingsAtom";
import type { GitFile } from "@src/types/git/types";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";
import { decodeOctalPath } from "@src/util/file/pathUtils";

const log = createLogger("usePerRepoSourceControl");

// ============================================
// Types
// ============================================

export interface UsePerRepoSourceControlOptions {
  repoPath: string;
  repoId: string;
  onGitFileSelect?: (file: GitFile) => void;
}

export interface PerRepoSourceControlState {
  files: GitFile[];
  filteredFiles: GitFile[];
  selectedFileId: string;
  loading: boolean;
  error: string | null;
  branchName?: string;
  stagedFilesCount: number;
  commitMessage: string;
  commitLoading: boolean;
  generateCommitMessageLoading: boolean;
  onGenerateCommitMessage: () => void;
  ahead: number;
  behind: number;
  hasUpstream: boolean;

  onFileSelect: (fileId: string) => void;
  onStageToggle: (fileId: string, stage: boolean) => Promise<void>;
  onDiscard: (fileId: string) => Promise<void>;
  onDiscardFiles: (fileIds: string[]) => Promise<void>;
  onStageAll: () => Promise<void>;
  onUnstageAll: () => Promise<void>;
  onDiscardAll: () => Promise<void>;
  onCommitMessageChange: (value: string) => void;
  onCommit: () => void;
  onSearchChange: (query: string) => void;
  searchQuery: string;
}

export interface UsePerRepoSourceControlResult {
  state: PerRepoSourceControlState;
  refresh: () => Promise<void>;
  loading: boolean;
}

// ============================================
// Hook
// ============================================

export function usePerRepoSourceControl(
  options: UsePerRepoSourceControlOptions
): UsePerRepoSourceControlResult {
  const { repoPath, repoId, onGitFileSelect } = options;
  const commitInstructions = useAtomValue(gitCommitInstructionsAtom);

  const [gitStatus, setGitStatus] = useState<GitStatusData | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFileId, setSelectedFileId] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [commitLoading, setCommitLoading] = useState(false);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [numstatMap, setNumstatMap] = useState<
    Map<string, { additions: number; deletions: number }>
  >(new Map());

  const mountedRef = useMounted();
  const filesRef = useRef<GitFile[]>([]);
  const onGitFileSelectRef = useRef(onGitFileSelect);

  // Scoped git API — binds repo_id/repo_path once
  const gitRef = useRef<ScopedGitApi>(createScopedGitApi(repoId, repoPath));
  useEffect(() => {
    gitRef.current = createScopedGitApi(repoId, repoPath);
  }, [repoId, repoPath]);

  useEffect(() => {
    onGitFileSelectRef.current = onGitFileSelect;
  }, [onGitFileSelect]);

  // Reset stale pane state immediately when the scoped repo path changes
  // (e.g. switching worktree scope) so the file list never flashes the
  // previous scope's files while the next status fetch is in flight.
  useEffect(() => {
    setGitStatus(null);
    setInitialLoading(true);
    setError(null);
    setSelectedFileId("");
    setNumstatMap(new Map());
  }, [repoPath]);

  // Load per-file numstat (non-blocking, runs after status)
  const fetchNumstat = useCallback(async () => {
    const raw = await fetchNumstatMap(repoId, repoPath);
    if (!mountedRef.current) return;
    // fetchNumstatMap paths are raw (not octal-decoded); decode here so they
    // match the already-decoded paths in `gitStatus`.
    const decoded = new Map<string, { additions: number; deletions: number }>();
    for (const [path, stats] of raw) {
      decoded.set(decodeOctalPath(path), stats);
    }
    setNumstatMap(decoded);
  }, [repoId, repoPath, mountedRef]);

  // Core fetch — only sets initialLoading on first call.
  // fetchNumstat only needs repoId/repoPath (not the status response), so
  // both requests are fired in parallel via Promise.all.
  const fetchStatus = useCallback(async () => {
    try {
      const [status] = await Promise.all([
        getGitStatus({ repo_id: repoId, repo_path: repoPath }),
        fetchNumstat(),
      ]);
      if (!mountedRef.current) return;
      if (status) {
        const decoded: GitStatusData = {
          ...status,
          working_directory: {
            ...status.working_directory,
            files: status.working_directory.files.map((file) => ({
              ...file,
              path: decodeOctalPath(file.path),
              original_path: file.original_path
                ? decodeOctalPath(file.original_path)
                : null,
            })),
          },
        };
        setGitStatus(decoded);
        setError(null);
      } else {
        setError("Failed to fetch git status");
      }
      setInitialLoading(false);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
        setInitialLoading(false);
      }
    }
  }, [repoId, repoPath, fetchNumstat, mountedRef]);

  // Debounced fetch for WebSocket events — replaces hand-rolled timer
  const debouncedFetch = useDebouncedCallback(
    () => fetchStatus(),
    DEBOUNCE_DELAYS.API
  );

  // Initial load
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // WebSocket listener — triggers debounced re-fetch on working-tree change
  useRepoStatusListener(repoId, debouncedFetch);

  // Derive files from gitStatus, enriched with numstat
  const files = useMemo<GitFile[]>(() => {
    if (!gitStatus?.working_directory?.files) return [];
    return gitStatus.working_directory.files.map(
      (file: GitWorkingDirectoryFile, index: number) => {
        const stats = numstatMap.get(file.path);
        return {
          id: `${repoId}:${file.path}-${index}`,
          path: file.path,
          status: normalizeGitStatus(file.status),
          additions: stats?.additions ?? 0,
          deletions: stats?.deletions ?? 0,
          staged: file.staged,
          original_path: file.original_path,
          oldContent: undefined,
          newContent: undefined,
        };
      }
    );
  }, [gitStatus, repoId, numstatMap]);

  // Keep ref in sync for stable callbacks
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const { searchQuery, setSearchQuery, filteredFiles, stagedFilesCount } =
    useFileSelection({ files, selectedFileId });

  // Memoize derived git metadata to avoid unnecessary child re-renders
  const branchName = useMemo(
    () => gitStatus?.current_branch ?? undefined,
    [gitStatus?.current_branch]
  );
  const ahead = useMemo(
    () => gitStatus?.branch_ahead_behind?.ahead ?? 0,
    [gitStatus?.branch_ahead_behind?.ahead]
  );
  const behind = useMemo(
    () => gitStatus?.branch_ahead_behind?.behind ?? 0,
    [gitStatus?.branch_ahead_behind?.behind]
  );
  const hasUpstream = useMemo(
    () => !!gitStatus?.current_upstream_branch,
    [gitStatus?.current_upstream_branch]
  );

  // ============================================
  // Stable callbacks — access files via ref to avoid cascade
  // ============================================

  const handleFileSelect = useCallback(
    (fileId: string) => {
      setSelectedFileId(fileId);
      const callback = onGitFileSelectRef.current;
      if (callback) {
        const file = filesRef.current.find((f) => f.id === fileId);
        if (file) callback(file);
      }
    },
    [] // stable — no deps
  );

  const handleStageToggle = useCallback(
    async (fileId: string, stage: boolean) => {
      const file = filesRef.current.find((f) => f.id === fileId);
      if (!file) return;
      try {
        const git = gitRef.current;
        if (stage) {
          await git.stage([file.path]);
        } else {
          await git.unstage([file.path]);
        }
        await fetchStatus();
      } catch (err) {
        log.error("[usePerRepoSourceControl] stage/unstage failed:", err);
      }
    },
    [fetchStatus]
  );

  const handleDiscard = useCallback(
    async (fileId: string) => {
      const file = filesRef.current.find((f) => f.id === fileId);
      if (!file) return;
      const fileName = file.path.split("/").pop() || file.path;

      const confirmed = await confirmDestructiveAction({
        title: `Discard changes to ${fileName}?`,
        message:
          "This will revert all changes in this file. This action cannot be undone.",
      });
      if (!confirmed) return;

      try {
        const isUntracked = file.status === "added" && !file.staged;
        if (isUntracked) {
          const absolutePath = file.path.startsWith("/")
            ? file.path
            : `${repoPath}/${file.path}`;
          await remove(absolutePath);
        } else {
          await gitRef.current.discard([file.path]);
        }
        await fetchStatus();
      } catch (err) {
        log.error("[usePerRepoSourceControl] discard failed:", err);
      }
    },
    [repoPath, fetchStatus]
  );

  const handleDiscardFiles = useCallback(
    async (fileIds: string[]) => {
      const files = filesRef.current.filter((file) =>
        fileIds.includes(file.id)
      );
      if (files.length === 0) return;

      const fileText =
        files.length === 1 ? files[0].path : `${files.length} files`;
      const confirmed = await confirmDestructiveAction({
        title: "Discard changes?",
        message: `This will revert all changes in ${fileText}. This action cannot be undone.`,
      });
      if (!confirmed) return;

      try {
        const untracked = files.filter(
          (file) => file.status === "added" && !file.staged
        );
        const tracked = files.filter(
          (file) => !(file.status === "added" && !file.staged)
        );

        await Promise.all(
          untracked.map((file) => {
            const absolutePath = file.path.startsWith("/")
              ? file.path
              : `${repoPath}/${file.path}`;
            return remove(absolutePath);
          })
        );

        if (tracked.length > 0) {
          await gitRef.current.discard(tracked.map((file) => file.path));
        }
        await fetchStatus();
      } catch (err) {
        log.error("[usePerRepoSourceControl] discard failed:", err);
      }
    },
    [repoPath, fetchStatus]
  );

  const handleStageAll = useCallback(async () => {
    const unstaged = filesRef.current.filter((f) => !f.staged);
    if (unstaged.length === 0) return;
    try {
      await gitRef.current.stage(unstaged.map((f) => f.path));
      await fetchStatus();
    } catch (err) {
      log.error("[usePerRepoSourceControl] stageAll failed:", err);
    }
  }, [fetchStatus]);

  const handleUnstageAll = useCallback(async () => {
    const staged = filesRef.current.filter((f) => f.staged);
    if (staged.length === 0) return;
    try {
      await gitRef.current.unstage(staged.map((f) => f.path));
      await fetchStatus();
    } catch (err) {
      log.error("[usePerRepoSourceControl] unstageAll failed:", err);
    }
  }, [fetchStatus]);

  const handleDiscardAll = useCallback(async () => {
    const unstaged = filesRef.current.filter((f) => !f.staged);
    if (unstaged.length === 0) return;

    const fileCount = unstaged.length;
    const fileText = fileCount === 1 ? "1 file" : `${fileCount} files`;
    const confirmed = await confirmDestructiveAction({
      title: "Discard all unstaged changes?",
      message: `This will revert all changes in ${fileText}. This action cannot be undone.`,
    });
    if (!confirmed) return;

    try {
      const untracked = unstaged.filter(
        (file) => file.status === "added" && !file.staged
      );
      const tracked = unstaged.filter(
        (file) => !(file.status === "added" && !file.staged)
      );

      await Promise.all(
        untracked.map((file) => {
          const absolutePath = file.path.startsWith("/")
            ? file.path
            : `${repoPath}/${file.path}`;
          return remove(absolutePath);
        })
      );

      if (tracked.length > 0) {
        await gitRef.current.discard(tracked.map((file) => file.path));
      }
      await fetchStatus();
    } catch (err) {
      log.error("[usePerRepoSourceControl] discardAll failed:", err);
    }
  }, [repoPath, fetchStatus]);

  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim()) return;
    setCommitLoading(true);
    try {
      const git = gitRef.current;
      const staged = filesRef.current.filter((f) => f.staged);
      if (staged.length === 0) {
        await git.stage(filesRef.current.map((f) => f.path));
      }
      await git.commit(commitMessage.trim());
      setCommitMessage("");
      await fetchStatus();
    } catch (err) {
      log.error("[usePerRepoSourceControl] commit failed:", err);
    } finally {
      setCommitLoading(false);
    }
  }, [commitMessage, fetchStatus]);

  const handleGenerateCommitMessage = useCallback(async () => {
    setGenerateLoading(true);
    try {
      const message = await generateCommitMessage(repoPath, commitInstructions);
      if (message) setCommitMessage(message);
    } catch (err) {
      log.error(
        "[usePerRepoSourceControl] generate commit message failed:",
        err
      );
    } finally {
      setGenerateLoading(false);
    }
  }, [repoPath, commitInstructions]);

  // ============================================
  // Assemble state — callbacks are stable, so this only
  // recomputes when data values actually change.
  // ============================================

  const state = useMemo<PerRepoSourceControlState>(
    () => ({
      files,
      filteredFiles,
      selectedFileId,
      loading: initialLoading,
      error,
      branchName,
      stagedFilesCount,
      commitMessage,
      commitLoading,
      generateCommitMessageLoading: generateLoading,
      onGenerateCommitMessage: handleGenerateCommitMessage,
      ahead,
      behind,
      hasUpstream,
      onFileSelect: handleFileSelect,
      onStageToggle: handleStageToggle,
      onDiscard: handleDiscard,
      onDiscardFiles: handleDiscardFiles,
      onStageAll: handleStageAll,
      onUnstageAll: handleUnstageAll,
      onDiscardAll: handleDiscardAll,
      onCommitMessageChange: setCommitMessage,
      onCommit: handleCommit,
      onSearchChange: setSearchQuery,
      searchQuery,
    }),
    [
      files,
      filteredFiles,
      selectedFileId,
      initialLoading,
      error,
      branchName,
      stagedFilesCount,
      commitMessage,
      commitLoading,
      generateLoading,
      handleGenerateCommitMessage,
      ahead,
      behind,
      hasUpstream,
      handleFileSelect,
      handleStageToggle,
      handleDiscard,
      handleDiscardFiles,
      handleStageAll,
      handleUnstageAll,
      handleDiscardAll,
      handleCommit,
      searchQuery,
      setSearchQuery,
    ]
  );

  return useMemo(
    () => ({ state, refresh: fetchStatus, loading: initialLoading }),
    [state, fetchStatus, initialLoading]
  );
}
