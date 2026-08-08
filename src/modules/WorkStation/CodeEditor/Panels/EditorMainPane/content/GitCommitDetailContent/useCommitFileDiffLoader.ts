import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CommitDiffResult } from "@src/api/http/git/types";
import { createLogger } from "@src/hooks/logger";
import {
  type CommitFileDiffRequest,
  type CommitFileDiffSnapshot,
  getCachedCommitFileDiff,
  getCommitFileDiffScopeKey,
  loadCommitFileDiff,
} from "@src/services/git/gitCommitDetailResource";
import { decodeOctalPath } from "@src/util/file/pathUtils";

const log = createLogger("GitCommitDetailContent");

type FileLoadState = "idle" | "loading" | "ready" | "error";

interface UseCommitFileDiffLoaderParams {
  commitSha: string;
  repoId: string;
  repoPath: string;
  isRepoReady: boolean;
  selectedFilePath: string | null;
  commitDiff: CommitDiffResult | null;
}

interface UseCommitFileDiffLoaderResult {
  fileOldContent: string;
  fileNewContent: string;
  selectedFileIsBinary: boolean;
  fileLoadState: FileLoadState;
  fileError: string | null;
  reloadFile: () => void;
}

interface FileLoaderState extends CommitFileDiffSnapshot {
  fileError: string | null;
  fileLoadState: FileLoadState;
  scopeKey: string | null;
}

const IDLE_STATE: FileLoaderState = {
  fileError: null,
  fileLoadState: "idle",
  isBinary: false,
  newContent: "",
  oldContent: "",
  scopeKey: null,
};

function readyState(
  scopeKey: string,
  snapshot: CommitFileDiffSnapshot
): FileLoaderState {
  return {
    ...snapshot,
    fileError: null,
    fileLoadState: "ready",
    scopeKey,
  };
}

/**
 * Fetches old/new file content for the selected commit file. Successful bodies
 * are kept in a small byte-bounded cache so remounting a Commit or Stash tab
 * does not blank the diff or repeat the same pair of git reads.
 */
export function useCommitFileDiffLoader({
  commitSha,
  repoId,
  repoPath,
  isRepoReady,
  selectedFilePath,
  commitDiff,
}: UseCommitFileDiffLoaderParams): UseCommitFileDiffLoaderResult {
  const fileInfo = useMemo(
    () =>
      selectedFilePath
        ? ((commitDiff?.files ?? []).find(
            (file) => decodeOctalPath(file.file_path) === selectedFilePath
          ) ?? null)
        : null,
    [commitDiff, selectedFilePath]
  );
  const request = useMemo<CommitFileDiffRequest | null>(
    () =>
      selectedFilePath && fileInfo
        ? {
            commitSha,
            filePath: selectedFilePath,
            fileStatus: fileInfo.status,
            parentSha: commitDiff?.parent_sha ?? null,
            repoId,
            repoPath,
          }
        : null,
    [
      commitDiff?.parent_sha,
      commitSha,
      fileInfo,
      repoId,
      repoPath,
      selectedFilePath,
    ]
  );
  const scopeKey = request ? getCommitFileDiffScopeKey(request) : null;
  const scopedInitialState = useMemo<FileLoaderState>(() => {
    if (!request || !scopeKey) return IDLE_STATE;
    const cached = getCachedCommitFileDiff(request);
    return cached
      ? readyState(scopeKey, cached)
      : { ...IDLE_STATE, fileLoadState: "loading", scopeKey };
  }, [request, scopeKey]);
  const [state, setState] = useState<FileLoaderState>(() => scopedInitialState);
  const loadGenerationRef = useRef(0);

  const runLoad = useCallback(
    async (force: boolean) => {
      if (!request || !scopeKey || !repoId || !isRepoReady) return;

      const requestId = ++loadGenerationRef.current;
      // Defer state publication until after the scope-derived render commits.
      await Promise.resolve();
      if (requestId !== loadGenerationRef.current) return;
      const cached = getCachedCommitFileDiff(request);
      setState((current) => {
        if (
          current.scopeKey === scopeKey &&
          current.fileLoadState === "ready"
        ) {
          return { ...current, fileError: null };
        }
        return cached
          ? readyState(scopeKey, cached)
          : { ...IDLE_STATE, fileLoadState: "loading", scopeKey };
      });

      log.debug("[GitCommitDetailContent] file_load_start", {
        commitSha,
        selectedFilePath,
      });

      try {
        const result = await loadCommitFileDiff(request, { force });
        if (requestId !== loadGenerationRef.current) return;
        setState(readyState(scopeKey, result));
      } catch (error) {
        if (requestId !== loadGenerationRef.current) return;
        const message =
          error instanceof Error
            ? error.message
            : `Failed to load content for ${selectedFilePath ?? ""}`;
        log.error("[GitCommitDetailContent] file_load_error", {
          commitSha,
          selectedFilePath,
          error,
        });
        setState((current) =>
          current.scopeKey === scopeKey && current.fileLoadState === "ready"
            ? { ...current, fileError: message }
            : {
                ...IDLE_STATE,
                fileError: message,
                fileLoadState: "error",
                scopeKey,
              }
        );
      }
    },
    [commitSha, isRepoReady, repoId, request, scopeKey, selectedFilePath]
  );

  useEffect(() => {
    if (!request) {
      loadGenerationRef.current += 1;
      return undefined;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void runLoad(false);
    });
    return () => {
      cancelled = true;
      loadGenerationRef.current += 1;
    };
  }, [request, runLoad]);

  const reloadFile = useCallback(() => {
    void runLoad(true);
  }, [runLoad]);

  const visibleState = state.scopeKey === scopeKey ? state : scopedInitialState;

  return {
    fileOldContent: visibleState.oldContent,
    fileNewContent: visibleState.newContent,
    selectedFileIsBinary: visibleState.isBinary,
    fileLoadState: visibleState.fileLoadState,
    fileError: visibleState.fileError,
    reloadFile,
  };
}
