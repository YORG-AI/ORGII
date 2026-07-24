/**
 * useGitEventListeners - WebSocket event listeners for git status updates
 *
 * Handles:
 * - repo:status_updated events from Rust file watcher
 * - file:changed events for file changes
 * - repo:git_operation events for operation notifications
 */
import { useEffect, useRef } from "react";

import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import { createLogger } from "@src/hooks/logger";
import type {
  GitFileStatusCode,
  GitRepositoryStatus,
  GitSuggestedAction,
  GitWorkingDirectoryFile,
} from "@src/types/session/steps";
import { decodeOctalPath } from "@src/util/file/pathUtils";
import { computeSuggestedAction } from "@src/util/git/computeSuggestedAction";
import { invalidateFileIndexCache } from "@src/util/platform/tauri/fileSearch";

import type { GitStatusRefs } from "../types";
import {
  createFileIndexInvalidationScheduler,
  fileChangeInvalidatesPathIndex,
  repoChangeInvalidatesPathIndex,
} from "./fileIndexInvalidation";

const log = createLogger("GitStatusContext");

interface UseGitEventListenersOptions {
  selectedRepoId: string | null;
  refs: Pick<GitStatusRefs, "currentRepoIdRef" | "gitStatusRef">;
  setGitStatus: (status: GitRepositoryStatus | null) => void;
  setGitSuggestedAction: (action: GitSuggestedAction | null) => void;
  setGitStatusAtom: (status: GitRepositoryStatus | null) => void;
  setGitSuggestedActionAtom: (action: GitSuggestedAction | null) => void;
  setGitOperation: (op: {
    repoId: string;
    operation: string;
    success: boolean;
    summary: string;
    details: string;
    timestamp: number;
  }) => void;
  resolveRepoPath: (repoId: string) => string | undefined;
}

export function useGitEventListeners({
  selectedRepoId,
  refs,
  setGitStatus,
  setGitSuggestedAction,
  setGitStatusAtom,
  setGitSuggestedActionAtom,
  setGitOperation,
  resolveRepoPath,
}: UseGitEventListenersOptions): void {
  const { currentRepoIdRef, gitStatusRef } = refs;

  // Keep setter callbacks in refs so adding/removing WebSocket listeners
  // does NOT re-trigger on every git-status write.  Any future refactor
  // that wraps these in useCallback would otherwise cause a listener-storm
  // on each status update.
  const setGitStatusRef = useRef(setGitStatus);
  const setGitSuggestedActionRef = useRef(setGitSuggestedAction);
  const setGitStatusAtomRef = useRef(setGitStatusAtom);
  const setGitSuggestedActionAtomRef = useRef(setGitSuggestedActionAtom);
  const setGitOperationRef = useRef(setGitOperation);
  const resolveRepoPathRef = useRef(resolveRepoPath);
  useEffect(() => {
    setGitStatusRef.current = setGitStatus;
  }, [setGitStatus]);
  useEffect(() => {
    setGitSuggestedActionRef.current = setGitSuggestedAction;
  }, [setGitSuggestedAction]);
  useEffect(() => {
    setGitStatusAtomRef.current = setGitStatusAtom;
  }, [setGitStatusAtom]);
  useEffect(() => {
    setGitSuggestedActionAtomRef.current = setGitSuggestedActionAtom;
  }, [setGitSuggestedActionAtom]);
  useEffect(() => {
    setGitOperationRef.current = setGitOperation;
  }, [setGitOperation]);
  useEffect(() => {
    resolveRepoPathRef.current = resolveRepoPath;
  }, [resolveRepoPath]);

  useEffect(() => {
    if (!selectedRepoId) return;

    const cleanupFns: (() => void)[] = [];
    const fileIndexInvalidation = createFileIndexInvalidationScheduler(
      invalidateFileIndexCache,
      250,
      (error) =>
        log.warn("[GitStatusContext] File index invalidation failed:", error)
    );

    const setupListeners = () => {
      try {
        const ws = getCodeEditorWebSocket();
        if (!ws) {
          log.error("[GitStatusContext] WebSocket client not available");
          return;
        }

        // Listen to repo:status_updated (main event from WebSocket)
        const unsubscribeStatus = ws.on("repo:status_updated", (data) => {
          const event = data as {
            type: string;
            repo_id: string;
            status: {
              branch?: string;
              current_upstream_branch?: string | null;
              last_commit_hash?: string;
              ahead?: number;
              behind?: number;
              staged?: number;
              unstaged?: number;
              untracked?: number;
              conflicted?: number;
              files?: Array<{
                path: string;
                status: string;
                staged: boolean;
                original_path?: string | null;
              }>;
              merge_head_found?: boolean;
              merge_in_progress?: boolean;
              rebase_in_progress?: boolean;
              cherry_pick_in_progress?: boolean;
              revert_in_progress?: boolean;
              bisect_in_progress?: boolean;
              do_conflicted_files_exist?: boolean;
            };
          };

          if (event.repo_id === currentRepoIdRef.current) {
            if (event.status) {
              const status = event.status;
              const prevStatus = gitStatusRef.current;

              // When prevStatus is null (cold-start race: the event fires
              // before fetchStatus() resolves), bootstrap from the event
              // payload directly instead of dropping it.  Dropping it means
              // the very first real-time push is always lost, leaving the UI
              // with empty git state until the next event.
              const prevFiles = prevStatus?.working_directory?.files ?? [];
              const prevFileMap = new Map(
                prevFiles.map((file) => [file.path, file])
              );

              const files: GitWorkingDirectoryFile[] =
                status.files?.map((file) => {
                  const prevFile = prevFileMap.get(file.path);
                  if (
                    prevFile &&
                    prevFile.status === file.status &&
                    prevFile.staged === file.staged &&
                    prevFile.original_path === (file.original_path ?? null)
                  ) {
                    return prevFile;
                  }
                  return {
                    path: decodeOctalPath(file.path),
                    status: file.status as GitFileStatusCode,
                    staged: file.staged,
                    original_path: file.original_path
                      ? decodeOctalPath(file.original_path)
                      : null,
                  };
                }) ?? [];

              const newStatus: GitRepositoryStatus = {
                current_branch:
                  status.branch || prevStatus?.current_branch || "",
                current_upstream_branch:
                  status.current_upstream_branch ??
                  prevStatus?.current_upstream_branch ??
                  null,
                current_tip: status.last_commit_hash || "",
                branch_ahead_behind: {
                  ahead: status.ahead || 0,
                  behind: status.behind || 0,
                },
                exists: true,
                merge_head_found:
                  status.merge_head_found ??
                  status.merge_in_progress ??
                  prevStatus?.merge_head_found ??
                  false,
                squash_msg_found: prevStatus?.squash_msg_found ?? false,
                rebase_in_progress:
                  status.rebase_in_progress ??
                  prevStatus?.rebase_in_progress ??
                  false,
                cherry_pick_in_progress:
                  status.cherry_pick_in_progress ??
                  prevStatus?.cherry_pick_in_progress ??
                  false,
                working_directory: {
                  files,
                  staged_count: status.staged || 0,
                  unstaged_count: status.unstaged || 0,
                  untracked_count: status.untracked || 0,
                },
                do_conflicted_files_exist:
                  status.do_conflicted_files_exist ??
                  (status.conflicted != null
                    ? status.conflicted > 0
                    : undefined) ??
                  prevStatus?.do_conflicted_files_exist ??
                  false,
              };

              setGitStatusRef.current(newStatus);
              setGitStatusAtomRef.current(newStatus);

              const suggestedAction = computeSuggestedAction(newStatus);
              setGitSuggestedActionRef.current(suggestedAction);
              setGitSuggestedActionAtomRef.current(suggestedAction);
            }
          }
        });
        cleanupFns.push(unsubscribeStatus);

        // The repository watcher emits this aggregate event for every real
        // filesystem burst. It is the canonical path-index invalidation source.
        const unsubscribeRepoChanged = ws.on("repo:changed", (data) => {
          const event = data as {
            repo_id?: string;
            change_type?: string;
          };
          if (
            !event.repo_id ||
            !repoChangeInvalidatesPathIndex(event.change_type)
          ) {
            return;
          }

          const rootPath = resolveRepoPathRef.current(event.repo_id);
          if (rootPath) fileIndexInvalidation.schedule(rootPath);
        });
        cleanupFns.push(unsubscribeRepoChanged);

        // Retain compatibility with granular file events from future or
        // alternate watcher producers.
        const unsubscribeChanged = ws.on("file:changed", (data) => {
          const event = data as {
            repo_id?: string;
            kind?: string;
            files?: Array<{ kind?: string }>;
          };
          if (!event.repo_id) return;

          const containsPathChange = event.files
            ? event.files.some((file) =>
                fileChangeInvalidatesPathIndex(file.kind)
              )
            : fileChangeInvalidatesPathIndex(event.kind);
          if (!containsPathChange) return;

          const rootPath = resolveRepoPathRef.current(event.repo_id);
          if (rootPath) fileIndexInvalidation.schedule(rootPath);
        });
        cleanupFns.push(unsubscribeChanged);

        // Listen to repo:git_operation for meaningful operation events
        const unsubscribeOperation = ws.on("repo:git_operation", (data) => {
          const event = data as {
            type: string;
            repo_id: string;
            operation: string;
            success: boolean;
            summary: string;
            details: string;
            timestamp: number;
          };

          if (event.repo_id === currentRepoIdRef.current) {
            setGitOperationRef.current({
              repoId: event.repo_id,
              operation: event.operation,
              success: event.success,
              summary: event.summary,
              details: event.details,
              timestamp: event.timestamp,
            });
          }
        });
        cleanupFns.push(unsubscribeOperation);
      } catch {
        // Not in Tauri - that's OK
      }
    };

    setupListeners();

    return () => {
      fileIndexInvalidation.dispose();
      cleanupFns.forEach((fn) => fn());
    };
  }, [
    selectedRepoId,
    currentRepoIdRef,
    gitStatusRef,
    // Setter refs (setGitStatus*, setGitOperation) are intentionally omitted:
    // they are stable Jotai/useState setters mirrored into refs above, so
    // including them would re-subscribe the entire WebSocket listener set on
    // every git-status write — a listener storm on each update.
  ]);
}
