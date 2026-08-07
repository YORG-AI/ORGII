import { useCallback, useEffect, useState } from "react";

import { getGitCommitDiff } from "@src/api/http/git/diff";
import type { CommitDiffResult } from "@src/api/http/git/types";
import { createLogger } from "@src/hooks/logger";
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

/**
 * Fetches the commit diff (file list + stats) for a given commit SHA.
 * Automatically selects the first file when the diff loads successfully.
 */
export function useCommitDiffLoader({
  commitSha,
  repoId,
  repoPath,
  isRepoReady,
  treatEmptyResultAsMissing = false,
}: UseCommitDiffLoaderParams): UseCommitDiffLoaderResult {
  const [commitDiff, setCommitDiff] = useState<CommitDiffResult | null>(null);
  const [commitLoadState, setCommitLoadState] =
    useState<CommitLoadState>("loading");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [commitReloadKey, setCommitReloadKey] = useState(0);

  const reloadCommit = useCallback(() => {
    setCommitLoadState("loading");
    setCommitError(null);
    setCommitDiff(null);
    setSelectedFilePath(null);
    setCommitReloadKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchDiff = async () => {
      if (!repoId || !repoPath || !isRepoReady) {
        logger.warn(
          `commit diff load skipped sha=${commitSha} repoId=${repoId} repoPath=${repoPath} ready=${isRepoReady}`,
          {
            commitSha,
            repoId,
            repoPath,
            isRepoReady,
          }
        );
        return;
      }

      logger.info(
        `commit diff load start sha=${commitSha} repoId=${repoId} repoPath=${repoPath}`,
        {
          commitSha,
          repoId,
          repoPath,
        }
      );
      setCommitLoadState("loading");
      setCommitError(null);
      setCommitDiff(null);
      setSelectedFilePath(null);

      try {
        const result = await getGitCommitDiff({
          repo_id: repoId,
          repo_path: repoPath,
          commit_sha: commitSha,
        });

        if (cancelled) return;

        if (!result) {
          logger.warn(
            `commit diff load returned empty result sha=${commitSha} repoId=${repoId} repoPath=${repoPath}`,
            {
              commitSha,
              repoId,
              repoPath,
            }
          );
          setCommitLoadState(treatEmptyResultAsMissing ? "missing" : "error");
          setCommitError(`commit=${commitSha}`);
          return;
        }

        setCommitDiff(result);

        const files = result.files ?? [];
        if (files.length === 0) {
          logger.info(
            `commit diff loaded with no files sha=${commitSha} repoId=${repoId} repoPath=${repoPath}`,
            {
              commitSha,
              repoId,
              repoPath,
            }
          );
          setCommitLoadState("no-files");
          return;
        }

        logger.info(
          `commit diff load ready sha=${commitSha} repoId=${repoId} repoPath=${repoPath} files=${files.length}`,
          {
            commitSha,
            repoId,
            repoPath,
            fileCount: files.length,
            firstFilePath: files[0]?.file_path,
          }
        );
        setCommitLoadState("ready");
        setSelectedFilePath(decodeOctalPath(files[0].file_path));
      } catch (err) {
        if (!cancelled) {
          logger.error(
            `commit diff load failed sha=${commitSha} repoId=${repoId} repoPath=${repoPath}`,
            {
              commitSha,
              repoId,
              repoPath,
              error: err,
            }
          );
          setCommitLoadState("error");
          setCommitError(
            err instanceof Error ? err.message : `commit=${commitSha}`
          );
        }
      }
    };

    fetchDiff();
    return () => {
      cancelled = true;
    };
  }, [
    commitSha,
    repoId,
    repoPath,
    isRepoReady,
    commitReloadKey,
    treatEmptyResultAsMissing,
  ]);

  return {
    commitDiff,
    commitLoadState,
    commitError,
    selectedFilePath,
    setSelectedFilePath,
    reloadCommit,
  };
}
