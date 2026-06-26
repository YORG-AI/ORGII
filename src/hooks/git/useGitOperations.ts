/**
 * useGitOperations Hook
 *
 * Unified hook for all git operations (push, pull, fetch, publish, sync).
 *
 * USES DISPATCH WHEN AVAILABLE - achieving true UI/AI unification.
 * Falls back to GitOperationsService directly when outside ActionSystemProvider.
 *
 * The operations go through GitOperationsService which:
 * - Uses streaming output to Output panel (when available)
 * - Falls back to API/terminal when streaming unavailable
 * - Provides identical behavior for human clicks, AI commands, and Spotlight
 *
 * This hook adds:
 * - Loading states for UI feedback
 * - Git status refresh after operations
 */
import { useCallback, useEffect, useState } from "react";

import { useActionSystemOptional } from "@src/ActionSystem";
import type { GitErrorType } from "@src/api/http/git/streaming";
import { useGitStatus } from "@src/contexts/git";
import { GitOperationsService } from "@src/services/git/GitOperationsService";
import type { GitPullStrategy } from "@src/store/ui/editorSettingsAtom";

// ============================================
// Types
// ============================================

export interface GitOperationResult {
  success: boolean;
  errorType: GitErrorType;
  message?: string;
}

export interface UseGitOperationsOptions {
  repoId?: string;
  repoPath?: string;
  useActionSystem?: boolean;
  showErrorDialogs?: boolean;
  /** Callback after successful operation */
  onSuccess?: () => void;
  /** Callback after any operation completes */
  onComplete?: () => void;
}

export interface GitOperationsLoadingState {
  push: boolean;
  pull: boolean;
  fetch: boolean;
  publish: boolean;
  sync: boolean;
}

export interface UseGitOperationsReturn {
  // Operations - all go through dispatch for unified behavior
  push: (opts?: { force?: boolean }) => Promise<GitOperationResult>;
  pull: (opts?: {
    strategy?: GitPullStrategy;
    showErrorDialogs?: boolean;
  }) => Promise<GitOperationResult>;
  fetch: (opts?: {
    remote?: string;
    prune?: boolean;
  }) => Promise<GitOperationResult>;
  publish: () => Promise<GitOperationResult>;
  sync: () => Promise<GitOperationResult>;

  // Loading states
  isLoading: GitOperationsLoadingState;
  isAnyLoading: boolean;
}

function normalizeGitOperationResult(
  success: boolean,
  message: string | undefined,
  data: unknown
): GitOperationResult {
  const maybeData = data as { errorType?: GitErrorType } | undefined;
  return {
    success,
    errorType: success ? "none" : (maybeData?.errorType ?? "unknown"),
    message,
  };
}

// ============================================
// Hook Implementation
// ============================================

export function useGitOperations(
  options: UseGitOperationsOptions = {}
): UseGitOperationsReturn {
  const {
    repoId,
    repoPath,
    useActionSystem = true,
    showErrorDialogs = true,
    onSuccess,
    onComplete,
  } = options;

  // Get dispatch for GUI actions - preferred path for unified logging
  const actionSystem = useActionSystemOptional();
  const dispatch = useActionSystem ? actionSystem?.dispatch : undefined;

  // Set repo context for GitOperationsService fallback
  // This ensures operations work even when outside ActionSystemProvider
  // NOTE: Must be in useEffect to avoid infinite re-renders
  useEffect(() => {
    if (repoId && repoPath) {
      GitOperationsService.setRepoContext(repoId, repoPath);
    }
  }, [repoId, repoPath]);

  // Get git status for refresh after operations
  const { forceRefresh } = useGitStatus();

  // Loading states
  const [loadingState, setLoadingState] = useState<GitOperationsLoadingState>({
    push: false,
    pull: false,
    fetch: false,
    publish: false,
    sync: false,
  });

  // Helper to set loading state
  const setLoading = useCallback(
    (operation: keyof GitOperationsLoadingState, loading: boolean) => {
      setLoadingState((prev) => ({ ...prev, [operation]: loading }));
    },
    []
  );

  // Defer git status refresh to next tick to reduce rendering pressure
  // immediately after an operation completes. The WebSocket-based
  // repo:status_updated event provides real-time updates anyway.
  const deferredRefresh = useCallback(() => {
    setTimeout(() => {
      forceRefresh();
    }, 32);
  }, [forceRefresh]);

  // ========================================
  // Push Operation - via dispatch or direct service
  // ========================================
  const push = useCallback(
    async (opts: { force?: boolean } = {}): Promise<GitOperationResult> => {
      setLoading("push", true);

      try {
        let result: GitOperationResult;

        if (dispatch) {
          // Use dispatch - goes through ActionSystem for unified logging
          const dispatchResult = await dispatch(
            "git.push",
            { force: opts.force },
            "user"
          );
          result = normalizeGitOperationResult(
            dispatchResult.success,
            dispatchResult.message,
            dispatchResult.data
          );
        } else {
          result = await GitOperationsService.push({
            force: opts.force,
            showErrorDialog: showErrorDialogs,
          });
        }

        deferredRefresh();

        // Callbacks
        if (result.success) {
          onSuccess?.();
        }
        onComplete?.();

        return result;
      } finally {
        setLoading("push", false);
      }
    },
    [
      dispatch,
      deferredRefresh,
      showErrorDialogs,
      onSuccess,
      onComplete,
      setLoading,
    ]
  );

  // ========================================
  // Pull Operation - via dispatch or direct service
  // ========================================
  const pull = useCallback(
    async (
      opts: { strategy?: GitPullStrategy; showErrorDialogs?: boolean } = {}
    ): Promise<GitOperationResult> => {
      setLoading("pull", true);

      try {
        let result: GitOperationResult;
        const shouldShowErrorDialogs =
          opts.showErrorDialogs ?? showErrorDialogs;

        if (dispatch && !opts.strategy) {
          // Use dispatch - goes through ActionSystem for unified logging
          const dispatchResult = await dispatch("git.pull", {}, "user");
          result = normalizeGitOperationResult(
            dispatchResult.success,
            dispatchResult.message,
            dispatchResult.data
          );
        } else if (shouldShowErrorDialogs) {
          result = await GitOperationsService.pullWithDialog({
            strategy: opts.strategy,
          });
        } else {
          result = await GitOperationsService.pull({
            strategy: opts.strategy,
            showErrorDialog: false,
          });
        }

        deferredRefresh();

        // Callbacks
        if (result.success) {
          onSuccess?.();
        }
        onComplete?.();

        return result;
      } finally {
        setLoading("pull", false);
      }
    },
    [
      dispatch,
      deferredRefresh,
      showErrorDialogs,
      onSuccess,
      onComplete,
      setLoading,
    ]
  );

  // ========================================
  // Fetch Operation - via dispatch or direct service
  // ========================================
  const fetch = useCallback(
    async (
      opts: { remote?: string; prune?: boolean } = {}
    ): Promise<GitOperationResult> => {
      setLoading("fetch", true);

      try {
        let result: GitOperationResult;

        if (dispatch) {
          // Use dispatch - goes through ActionSystem for unified logging
          const dispatchResult = await dispatch("git.fetch", {}, "user");
          result = normalizeGitOperationResult(
            dispatchResult.success,
            dispatchResult.message,
            dispatchResult.data
          );
        } else if (showErrorDialogs) {
          result = await GitOperationsService.fetchWithDialog({
            remote: opts.remote,
            prune: opts.prune,
          });
        } else {
          result = await GitOperationsService.fetch({
            remote: opts.remote,
            prune: opts.prune,
            showErrorDialog: showErrorDialogs,
          });
        }

        deferredRefresh();

        // Callbacks
        if (result.success) {
          onSuccess?.();
        }
        onComplete?.();

        return result;
      } finally {
        setLoading("fetch", false);
      }
    },
    [
      dispatch,
      deferredRefresh,
      showErrorDialogs,
      onSuccess,
      onComplete,
      setLoading,
    ]
  );

  // ========================================
  // Publish Operation - via dispatch or direct service
  // ========================================
  const publish = useCallback(async (): Promise<GitOperationResult> => {
    setLoading("publish", true);

    try {
      let result: GitOperationResult;

      if (dispatch) {
        // Use dispatch - goes through ActionSystem for unified logging
        const dispatchResult = await dispatch("git.publish", {}, "user");
        result = normalizeGitOperationResult(
          dispatchResult.success,
          dispatchResult.message,
          dispatchResult.data
        );
      } else {
        result = await GitOperationsService.push({
          setUpstream: true,
          showErrorDialog: showErrorDialogs,
        });
      }

      deferredRefresh();

      // Callbacks
      if (result.success) {
        onSuccess?.();
      }
      onComplete?.();

      return result;
    } finally {
      setLoading("publish", false);
    }
  }, [
    dispatch,
    deferredRefresh,
    showErrorDialogs,
    onSuccess,
    onComplete,
    setLoading,
  ]);

  // ========================================
  // Sync Operation - via dispatch or direct service
  // ========================================
  const sync = useCallback(async (): Promise<GitOperationResult> => {
    setLoading("sync", true);

    try {
      let result: GitOperationResult;

      if (dispatch) {
        // Use dispatch - goes through ActionSystem for unified logging
        const dispatchResult = await dispatch("git.sync", {}, "user");
        result = normalizeGitOperationResult(
          dispatchResult.success,
          dispatchResult.message,
          dispatchResult.data
        );
      } else if (showErrorDialogs) {
        result = await GitOperationsService.syncWithDialog();
      } else {
        result = await GitOperationsService.sync({
          showErrorDialog: showErrorDialogs,
        });
      }

      deferredRefresh();

      // Callbacks
      if (result.success) {
        onSuccess?.();
      }
      onComplete?.();

      return result;
    } finally {
      setLoading("sync", false);
    }
  }, [
    dispatch,
    deferredRefresh,
    showErrorDialogs,
    onSuccess,
    onComplete,
    setLoading,
  ]);

  // ========================================
  // Computed values
  // ========================================
  const isAnyLoading =
    loadingState.push ||
    loadingState.pull ||
    loadingState.fetch ||
    loadingState.publish ||
    loadingState.sync;

  // ========================================
  // Return
  // ========================================
  return {
    // Operations
    push,
    pull,
    fetch,
    publish,
    sync,

    // Loading states
    isLoading: loadingState,
    isAnyLoading,
  };
}

export default useGitOperations;
