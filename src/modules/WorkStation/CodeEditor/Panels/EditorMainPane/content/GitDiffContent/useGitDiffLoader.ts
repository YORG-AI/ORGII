/**
 * Self-fetch fallback for missing diff content.
 *
 * Working-tree file selection intentionally carries metadata only. The
 * rendered diff turns `oldContent: undefined` into real content and remains
 * self-sufficient if the Source Control sidebar unmounts.
 *
 * This hook makes `GitDiffContent` self-sufficient. It is the sole owner of
 * loading a focused working-tree diff body; the shared resource de-duplicates
 * any overlapping consumer at the request boundary.
 */
import { useEffect, useMemo, useState } from "react";

import { createLogger } from "@src/hooks/logger";
import {
  type WorkingTreeDiffRequest,
  loadWorkingTreeDiff,
} from "@src/services/git/workingTreeDiffResource";
import type { GitFile } from "@src/types/git/types";

const log = createLogger("GitDiffContent");

interface FetchedDiff {
  path: string;
  oldContent: string;
  newContent: string;
  additions: number;
  deletions: number;
}

interface UseGitDiffLoaderOptions {
  gitFile: GitFile | null;
  repoPath: string;
}

interface UseGitDiffLoaderResult {
  /** The gitFile merged with self-fetched content (when needed). */
  effectiveGitFile: GitFile | null;
  /** True while a self-fetch is in flight. */
  selfFetching: boolean;
}

interface DiffLoadState {
  requestKey: string | null;
  fetchedDiff: FetchedDiff | null;
  selfFetching: boolean;
}

function getDiffRequestKey(gitFile: GitFile | null, repoPath: string) {
  if (!gitFile || !repoPath || gitFile.oldContent !== undefined) return null;
  if (gitFile.id?.startsWith("timeline:")) return null;
  return JSON.stringify([
    repoPath,
    gitFile.id,
    gitFile.path,
    gitFile.original_path,
    gitFile.status,
    gitFile.staged,
    gitFile.repoRoot,
  ]);
}

function getDiffRequest(
  requestKey: string | null
): WorkingTreeDiffRequest | null {
  if (!requestKey) return null;
  const [repoPath, , path, originalPath, status, staged, repoRoot] = JSON.parse(
    requestKey
  ) as [
    string,
    string,
    string,
    string | null,
    GitFile["status"],
    boolean,
    string | null,
  ];
  return {
    repoPath,
    file: {
      path,
      original_path: originalPath,
      status,
      staged,
      repoRoot: repoRoot ?? undefined,
    },
  };
}

export function useGitDiffLoader({
  gitFile,
  repoPath,
}: UseGitDiffLoaderOptions): UseGitDiffLoaderResult {
  const requestKey = getDiffRequestKey(gitFile, repoPath);
  const diffRequest = useMemo(() => getDiffRequest(requestKey), [requestKey]);
  const [loadState, setLoadState] = useState<DiffLoadState>(() => ({
    requestKey,
    fetchedDiff: null,
    selfFetching: requestKey !== null,
  }));
  const nextLoadState =
    loadState.requestKey === requestKey
      ? loadState
      : {
          requestKey,
          fetchedDiff: null,
          selfFetching: requestKey !== null,
        };
  if (nextLoadState !== loadState) {
    setLoadState(nextLoadState);
  }
  const { fetchedDiff, selfFetching } = nextLoadState;

  useEffect(() => {
    if (!requestKey || !diffRequest) return;
    const diffPath = diffRequest.file.path;
    if (fetchedDiff?.path === diffPath) return;

    let cancelled = false;
    loadWorkingTreeDiff(diffRequest)
      .then((diff) => {
        if (cancelled) return;
        if (!diff) {
          setLoadState((current) =>
            current.requestKey === requestKey
              ? {
                  ...current,
                  fetchedDiff: {
                    path: diffPath,
                    oldContent: "",
                    newContent: "",
                    additions: 0,
                    deletions: 0,
                  },
                  selfFetching: false,
                }
              : current
          );
          return;
        }
        setLoadState((current) =>
          current.requestKey === requestKey
            ? {
                ...current,
                fetchedDiff: {
                  path: diffPath,
                  oldContent: diff.oldContent,
                  newContent: diff.newContent,
                  additions: diff.additions,
                  deletions: diff.deletions,
                },
                selfFetching: false,
              }
            : current
        );
      })
      .catch((error) => {
        if (cancelled) return;
        log.error("[GitDiffContent] Self-fetch failed:", error);
        setLoadState((current) =>
          current.requestKey === requestKey
            ? {
                ...current,
                fetchedDiff: {
                  path: diffPath,
                  oldContent: "",
                  newContent: "",
                  additions: 0,
                  deletions: 0,
                },
                selfFetching: false,
              }
            : current
        );
      });

    return () => {
      cancelled = true;
    };
  }, [diffRequest, fetchedDiff?.path, requestKey]);

  // Effective gitFile = prop ∪ self-fetched override (when prop content is missing).
  const effectiveGitFile = useMemo<GitFile | null>(() => {
    if (!gitFile) return null;
    if (gitFile.oldContent !== undefined) return gitFile;
    if (fetchedDiff && fetchedDiff.path === gitFile.path) {
      return {
        ...gitFile,
        oldContent: fetchedDiff.oldContent,
        newContent: fetchedDiff.newContent,
        additions: fetchedDiff.additions,
        deletions: fetchedDiff.deletions,
      };
    }
    return gitFile;
  }, [gitFile, fetchedDiff]);

  return { effectiveGitFile, selfFetching };
}
