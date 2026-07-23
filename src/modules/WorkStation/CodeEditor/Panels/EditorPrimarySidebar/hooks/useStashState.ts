/**
 * useStashState Hook
 *
 * Manages git stash operations including:
 * - List all stashes
 * - Create new stash (push)
 * - Apply stash (with or without pop)
 * - Drop stash
 *
 * Uses dispatch() for all stash operations to ensure AI/human unification.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useActionSystemOptional } from "@src/ActionSystem";
import { gitApi } from "@src/api/http/git";
import type { StashEntry } from "@src/api/http/git/types";
import {
  type AsyncResourceFetchContext,
  useAsyncResource,
} from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";
import { showGitActionDialogSafely } from "@src/util/dialogs/gitActionDialog";

const log = createLogger("useStashState");

export interface UseStashStateOptions {
  /** Repository ID (UUID) */
  repoId: string;
  /** Repository path */
  repoPath: string;
  /** Whether to auto-load stash list on mount */
  autoLoad?: boolean;
  /** Callback after successful stash operation (to refresh git status) */
  onStashChange?: () => Promise<void>;
}

export interface UseStashStateResult {
  /** List of stashes */
  stashes: StashEntry[];
  /** Whether stash list is loading */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Number of stashes */
  stashCount: number;
  /** Refresh stash list */
  refresh: () => Promise<void>;
  /** Create a new stash */
  stashPush: (message?: string, includeUntracked?: boolean) => Promise<boolean>;
  /** Apply a stash (keeps stash in list) */
  stashApply: (index: number) => Promise<boolean>;
  /** Pop a stash (applies and removes from list) */
  stashPop: (index: number) => Promise<boolean>;
  /** Drop a stash (removes without applying) */
  stashDrop: (index: number) => Promise<boolean>;
  /** Whether any stash operation is in progress */
  operationLoading: boolean;
}

function stripGitPrefix(msg: string): string {
  return msg.startsWith("Git operation failed: ")
    ? msg.replace("Git operation failed: ", "")
    : msg;
}

export function useStashState(
  options: UseStashStateOptions
): UseStashStateResult {
  const { repoId, repoPath, autoLoad = true, onStashChange } = options;
  const { t } = useTranslation();

  const actionSystem = useActionSystemOptional();
  const dispatch = actionSystem?.dispatch;

  const [operationLoading, setOperationLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStashes = useCallback(
    async (
      serializedScope: string,
      context: AsyncResourceFetchContext<StashEntry[]>
    ) => {
      const scope = JSON.parse(serializedScope) as {
        repoId: string;
        repoPath: string;
      };
      try {
        const result = await gitApi.gitStashList({
          repo_id: scope.repoId,
          repo_path: scope.repoPath,
        });
        return result?.stashes ?? [];
      } catch (caughtError) {
        log.error("[useStashState] Failed to fetch stash list:", caughtError);
        if (context.isCurrent()) context.publish([]);
        throw caughtError;
      }
    },
    []
  );
  const scopeKey = repoId ? JSON.stringify({ repoId, repoPath }) : null;
  const stashResource = useAsyncResource<StashEntry[]>({
    autoLoad,
    enabled: Boolean(scopeKey),
    fetcher: fetchStashes,
    initialData: [],
    scopeKey,
  });
  const refreshResource = stashResource.refresh;
  const refresh = useCallback(async () => {
    setError(null);
    await refreshResource();
  }, [refreshResource]);

  useEffect(() => {
    setError(null);
  }, [repoId, repoPath]);

  /*
   * Operation state remains local: it represents an explicit user mutation,
   * while the list resource above owns only read/refresh lifecycle.
   */

  // Create a new stash - uses dispatch
  const stashPush = useCallback(
    async (message?: string, includeUntracked = false): Promise<boolean> => {
      if (!repoId) return false;

      setOperationLoading(true);
      setError(null);

      try {
        if (dispatch) {
          const result = await dispatch(
            "git.stash",
            { message, includeUntracked },
            "user"
          );

          if (result.success) {
            showGitActionDialogSafely(
              message
                ? t("git.messages.stashPushSuccessNamed", { message })
                : t("git.messages.stashPushSuccess"),
              "info"
            );
            await refresh();
            await onStashChange?.();
            return true;
          } else {
            const errorMsg = result.message || "Failed to stash changes";
            showGitActionDialogSafely(errorMsg, "error");
            setError(errorMsg);
            return false;
          }
        }

        // Fallback if dispatch not available
        const result = await gitApi.gitStashPush({
          repo_id: repoId,
          repo_path: repoPath,
          message: message || null,
          include_untracked: includeUntracked,
        });

        if (result?.success) {
          showGitActionDialogSafely(
            message
              ? t("git.messages.stashPushSuccessNamed", { message })
              : t("git.messages.stashPushSuccess"),
            "info"
          );
          await refresh();
          await onStashChange?.();
          return true;
        } else {
          const errorMsg = result?.message || "Failed to stash changes";
          showGitActionDialogSafely(errorMsg, "error");
          setError(errorMsg);
          return false;
        }
      } catch (err) {
        log.error("[useStashState] Failed to stash push:", err);
        const errorMsg =
          err instanceof Error ? err.message : "Failed to stash changes";
        showGitActionDialogSafely(errorMsg, "error");
        setError(errorMsg);
        return false;
      } finally {
        setOperationLoading(false);
      }
    },
    [repoId, repoPath, refresh, onStashChange, dispatch, t]
  );

  // Apply a stash (keeps stash in list) - uses dispatch
  const stashApply = useCallback(
    async (index: number): Promise<boolean> => {
      if (!repoId) return false;

      const stashRef = `stash@{${index}}`;
      setOperationLoading(true);
      setError(null);

      try {
        if (dispatch) {
          const result = await dispatch("git.stashApply", { index }, "user");

          if (result.success) {
            showGitActionDialogSafely(
              t("git.messages.stashApplySuccess", { stashRef }),
              "info"
            );
            await onStashChange?.();
            return true;
          } else {
            const errorMsg = result.message || "Failed to apply stash";
            showGitActionDialogSafely(errorMsg, "error");
            setError(errorMsg);
            return false;
          }
        }

        // Fallback if dispatch not available
        const result = await gitApi.gitStashApply({
          repo_id: repoId,
          repo_path: repoPath,
          index,
          pop: false,
        });

        if (result?.success) {
          showGitActionDialogSafely(
            t("git.messages.stashApplySuccess", { stashRef }),
            "info"
          );
          await onStashChange?.();
          return true;
        } else {
          const errorMsg = stripGitPrefix(
            result?.message || "Failed to apply stash"
          );
          showGitActionDialogSafely(
            t("git.messages.stashApplyFailed", { error: errorMsg }),
            "error"
          );
          setError(errorMsg);
          return false;
        }
      } catch (err) {
        log.error("[useStashState] Failed to apply stash:", err);
        const errorMsg = stripGitPrefix(
          err instanceof Error ? err.message : "Failed to apply stash"
        );
        showGitActionDialogSafely(
          t("git.messages.stashApplyFailed", { error: errorMsg }),
          "error"
        );
        setError(errorMsg);
        return false;
      } finally {
        setOperationLoading(false);
      }
    },
    [repoId, repoPath, onStashChange, dispatch, t]
  );

  // Pop a stash (applies and removes from list) - uses dispatch
  const stashPop = useCallback(
    async (index: number): Promise<boolean> => {
      if (!repoId) return false;

      const stashRef = `stash@{${index}}`;
      setOperationLoading(true);
      setError(null);

      try {
        if (dispatch) {
          const result = await dispatch("git.stashPop", { index }, "user");

          if (result.success) {
            showGitActionDialogSafely(
              t("git.messages.stashPopSuccess", { stashRef }),
              "info"
            );
            await refresh();
            await onStashChange?.();
            return true;
          } else {
            const errorMsg = result.message || "Failed to pop stash";
            showGitActionDialogSafely(errorMsg, "error");
            setError(errorMsg);
            return false;
          }
        }

        // Fallback if dispatch not available
        const result = await gitApi.gitStashApply({
          repo_id: repoId,
          repo_path: repoPath,
          index,
          pop: true,
        });

        if (result?.success) {
          showGitActionDialogSafely(
            t("git.messages.stashPopSuccess", { stashRef }),
            "info"
          );
          await refresh();
          await onStashChange?.();
          return true;
        } else {
          const errorMsg = stripGitPrefix(
            result?.message || "Failed to pop stash"
          );
          showGitActionDialogSafely(
            t("git.messages.stashPopFailed", { error: errorMsg }),
            "error"
          );
          setError(errorMsg);
          return false;
        }
      } catch (err) {
        log.error("[useStashState] Failed to pop stash:", err);
        const errorMsg = stripGitPrefix(
          err instanceof Error ? err.message : "Failed to pop stash"
        );
        showGitActionDialogSafely(
          t("git.messages.stashPopFailed", { error: errorMsg }),
          "error"
        );
        setError(errorMsg);
        return false;
      } finally {
        setOperationLoading(false);
      }
    },
    [repoId, repoPath, refresh, onStashChange, dispatch, t]
  );

  // Drop a stash (removes without applying) - uses dispatch
  const stashDrop = useCallback(
    async (index: number): Promise<boolean> => {
      if (!repoId) return false;

      const stashRef = `stash@{${index}}`;
      setOperationLoading(true);
      setError(null);

      try {
        if (dispatch) {
          const result = await dispatch("git.stashDrop", { index }, "user");

          if (result.success) {
            showGitActionDialogSafely(
              t("git.messages.stashDropSuccess", { stashRef }),
              "info"
            );
            await refresh();
            return true;
          } else {
            const errorMsg = result.message || "Failed to drop stash";
            showGitActionDialogSafely(errorMsg, "error");
            setError(errorMsg);
            return false;
          }
        }

        // Fallback if dispatch not available
        const result = await gitApi.gitStashDrop({
          repo_id: repoId,
          repo_path: repoPath,
          index,
        });

        if (result?.success) {
          showGitActionDialogSafely(
            t("git.messages.stashDropSuccess", { stashRef }),
            "info"
          );
          await refresh();
          return true;
        } else {
          const errorMsg = stripGitPrefix(
            result?.message || "Failed to drop stash"
          );
          showGitActionDialogSafely(
            t("git.messages.stashDropFailed", { error: errorMsg }),
            "error"
          );
          setError(errorMsg);
          return false;
        }
      } catch (err) {
        log.error("[useStashState] Failed to drop stash:", err);
        const errorMsg = stripGitPrefix(
          err instanceof Error ? err.message : "Failed to drop stash"
        );
        showGitActionDialogSafely(
          t("git.messages.stashDropFailed", { error: errorMsg }),
          "error"
        );
        setError(errorMsg);
        return false;
      } finally {
        setOperationLoading(false);
      }
    },
    [repoId, repoPath, refresh, dispatch, t]
  );

  return {
    stashes: stashResource.data,
    loading: stashResource.loading,
    error: error ?? stashResource.error,
    stashCount: stashResource.data.length,
    refresh,
    stashPush,
    stashApply,
    stashPop,
    stashDrop,
    operationLoading,
  };
}

export default useStashState;
