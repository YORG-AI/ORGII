import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CommitDiffResult } from "@src/api/http/git/types";
import { createLogger } from "@src/hooks/logger";
import {
  type CommitDetailRequest,
  getCachedCommitDiff,
  getCachedCommitSelection,
  getCommitDetailScopeKey,
  loadCommitDiff,
  setCachedCommitSelection,
} from "@src/services/git/gitCommitDetailResource";
import { decodeOctalPath } from "@src/util/file/pathUtils";

type CommitLoadState = "loading" | "ready" | "error" | "no-files" | "missing";

const logger = createLogger("GitCommitDetailContent");

interface UseCommitDiffLoaderParams {
  commitSha: string;
  repoId: string;
  repoPath: string;
  isRepoReady: boolean;
  treatEmptyResultAsMissing?: boolean;
}

interface UseCommitDiffLoaderResult {
  commitDiff: CommitDiffResult | null;
  commitLoadState: CommitLoadState;
  commitError: string | null;
  selectedFilePath: string | null;
  setSelectedFilePath: (path: string | null) => void;
  reloadCommit: () => void;
}

interface CommitLoaderState {
  commitDiff: CommitDiffResult | null;
  commitError: string | null;
  commitLoadState: CommitLoadState;
  scopeKey: string;
  selectedFilePath: string | null;
}

function selectAvailableFile(
  request: CommitDetailRequest,
  commitDiff: CommitDiffResult,
  preferredPath?: string | null
): string | null {
  const files = commitDiff.files ?? [];
  const decodedPaths = files.map((file) => decodeOctalPath(file.file_path));
  const cachedPath = getCachedCommitSelection(request);
  const selectedPath =
    (preferredPath && decodedPaths.includes(preferredPath)
      ? preferredPath
      : null) ??
    (cachedPath && decodedPaths.includes(cachedPath) ? cachedPath : null) ??
    decodedPaths[0] ??
    null;
  return selectedPath;
}

function stateFromDiff(
  request: CommitDetailRequest,
  scopeKey: string,
  commitDiff: CommitDiffResult,
  preferredPath?: string | null
): CommitLoaderState {
  const files = commitDiff.files ?? [];
  return {
    commitDiff,
    commitError: null,
    commitLoadState: files.length === 0 ? "no-files" : "ready",
    scopeKey,
    selectedFilePath: selectAvailableFile(request, commitDiff, preferredPath),
  };
}

function initialState(
  request: CommitDetailRequest,
  scopeKey: string
): CommitLoaderState {
  const cachedDiff = getCachedCommitDiff(request);
  return cachedDiff
    ? stateFromDiff(request, scopeKey, cachedDiff)
    : {
        commitDiff: null,
        commitError: null,
        commitLoadState: "loading",
        scopeKey,
        selectedFilePath: null,
      };
}

/**
 * Fetches the commit diff (file list + stats) for a given commit SHA.
 * Successful immutable SHA data and the selected file survive tab remounts in
 * a bounded app-session cache; explicit reload preserves visible data while
 * the replacement request is pending.
 */
export function useCommitDiffLoader({
  commitSha,
  repoId,
  repoPath,
  isRepoReady,
  treatEmptyResultAsMissing = false,
}: UseCommitDiffLoaderParams): UseCommitDiffLoaderResult {
  const request = useMemo<CommitDetailRequest>(
    () => ({ commitSha, repoId, repoPath }),
    [commitSha, repoId, repoPath]
  );
  const scopeKey = getCommitDetailScopeKey(request);
  const scopedInitialState = useMemo(
    () => initialState(request, scopeKey),
    [request, scopeKey]
  );
  const [state, setState] = useState<CommitLoaderState>(
    () => scopedInitialState
  );
  const loadGenerationRef = useRef(0);

  const runLoad = useCallback(
    async (force: boolean) => {
      if (!repoId || !repoPath || !isRepoReady) return;

      const requestId = ++loadGenerationRef.current;
      // Let the scope-derived render state paint first. This also keeps the
      // effect entry point from synchronously cascading into another render.
      await Promise.resolve();
      if (requestId !== loadGenerationRef.current) return;
      const cachedDiff = getCachedCommitDiff(request);
      setState((current) => {
        if (current.scopeKey === scopeKey && current.commitDiff) {
          return { ...current, commitError: null };
        }
        return cachedDiff
          ? stateFromDiff(request, scopeKey, cachedDiff)
          : {
              commitDiff: null,
              commitError: null,
              commitLoadState: "loading",
              scopeKey,
              selectedFilePath: null,
            };
      });

      logger.info(
        `commit diff load start sha=${commitSha} repoId=${repoId} repoPath=${repoPath}`,
        { commitSha, repoId, repoPath }
      );

      try {
        const result = await loadCommitDiff(request, { force });
        if (requestId !== loadGenerationRef.current) return;

        if (!result) {
          logger.warn(
            `commit diff load returned empty result sha=${commitSha} repoId=${repoId} repoPath=${repoPath}`,
            { commitSha, repoId, repoPath }
          );
          setState({
            commitDiff: null,
            commitError: `commit=${commitSha}`,
            commitLoadState: treatEmptyResultAsMissing ? "missing" : "error",
            scopeKey,
            selectedFilePath: null,
          });
          return;
        }

        setState((current) =>
          stateFromDiff(
            request,
            scopeKey,
            result,
            current.scopeKey === scopeKey ? current.selectedFilePath : null
          )
        );
      } catch (error) {
        if (requestId !== loadGenerationRef.current) return;
        const message =
          error instanceof Error ? error.message : `commit=${commitSha}`;
        logger.error(
          `commit diff load failed sha=${commitSha} repoId=${repoId} repoPath=${repoPath}`,
          { commitSha, repoId, repoPath, error }
        );
        setState((current) =>
          current.scopeKey === scopeKey && current.commitDiff
            ? { ...current, commitError: message }
            : {
                commitDiff: null,
                commitError: message,
                commitLoadState: "error",
                scopeKey,
                selectedFilePath: null,
              }
        );
      }
    },
    [
      commitSha,
      isRepoReady,
      repoId,
      repoPath,
      request,
      scopeKey,
      treatEmptyResultAsMissing,
    ]
  );

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void runLoad(false);
    });
    return () => {
      cancelled = true;
      loadGenerationRef.current += 1;
    };
  }, [runLoad]);

  const reloadCommit = useCallback(() => {
    void runLoad(true);
  }, [runLoad]);

  const setSelectedFilePath = useCallback(
    (path: string | null) => {
      setCachedCommitSelection(request, path);
      setState((current) =>
        current.scopeKey === scopeKey
          ? { ...current, selectedFilePath: path }
          : current
      );
    },
    [request, scopeKey]
  );

  const visibleState = state.scopeKey === scopeKey ? state : scopedInitialState;

  useEffect(() => {
    setCachedCommitSelection(request, visibleState.selectedFilePath);
  }, [request, visibleState.selectedFilePath]);

  return {
    commitDiff: visibleState.commitDiff,
    commitLoadState: visibleState.commitLoadState,
    commitError: visibleState.commitError,
    selectedFilePath: visibleState.selectedFilePath,
    setSelectedFilePath,
    reloadCommit,
  };
}
