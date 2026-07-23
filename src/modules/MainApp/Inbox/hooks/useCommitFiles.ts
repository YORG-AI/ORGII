/**
 * useCommitFiles Hook
 *
 * Lazily fetches changed files for a git commit message.
 * Only triggers when the message is a commit (id starts with "git-commit-").
 * Caches results by commit SHA to avoid re-fetching.
 */
import { useAtomValue } from "jotai";
import { useCallback, useRef } from "react";

import { getGitCommitDiff } from "@src/api/http/git/diff";
import type {
  CommitDiffResult,
  GitFileDiffStatus,
} from "@src/api/http/git/types";
import { useAsyncResource } from "@src/hooks/async";
import { selectedRepoIdAtom, selectedRepoPathAtom } from "@src/store/repo";
import { decodeOctalPath } from "@src/util/file/pathUtils";

export interface CommitFileInfo {
  path: string;
  status: GitFileDiffStatus;
  additions: number;
  deletions: number;
}

interface UseCommitFilesResult {
  files: CommitFileInfo[];
  loading: boolean;
  totalStats: { additions: number; deletions: number } | null;
}

const MAX_CACHE_SIZE = 50;

interface CommitFilesData {
  files: CommitFileInfo[];
  totalStats: { additions: number; deletions: number } | null;
}

const EMPTY_COMMIT_FILES: CommitFilesData = {
  files: [],
  totalStats: null,
};

function mapCommitDiff(result: CommitDiffResult): CommitFilesData {
  return {
    files: result.files.map((file) => ({
      path: decodeOctalPath(file.file_path),
      status: file.status,
      additions: file.insertions ?? 0,
      deletions: file.deletions ?? 0,
    })),
    totalStats: {
      additions: result.stats?.insertions ?? 0,
      deletions: result.stats?.deletions ?? 0,
    },
  };
}

export function useCommitFiles(messageId: string): UseCommitFilesResult {
  const selectedRepoId = useAtomValue(selectedRepoIdAtom);
  const selectedRepoPath = useAtomValue(selectedRepoPathAtom);
  const cacheRef = useRef<Map<string, CommitDiffResult>>(new Map());

  const isCommit = messageId.startsWith("git-commit-");
  const commitSha = isCommit ? messageId.replace("git-commit-", "") : null;

  const fetchCommitFiles = useCallback(async (serializedScope: string) => {
    const cached = cacheRef.current.get(serializedScope);
    if (cached) return mapCommitDiff(cached);

    const scope = JSON.parse(serializedScope) as {
      commitSha: string;
      repoId: string;
      repoPath: string | null;
    };
    try {
      const result = await getGitCommitDiff({
        repo_id: scope.repoId,
        repo_path: scope.repoPath || undefined,
        commit_sha: scope.commitSha,
        context_lines: 0,
      });
      if (!result) return EMPTY_COMMIT_FILES;

      if (cacheRef.current.size >= MAX_CACHE_SIZE) {
        const firstKey = cacheRef.current.keys().next().value;
        if (firstKey) cacheRef.current.delete(firstKey);
      }
      cacheRef.current.set(serializedScope, result);
      return mapCommitDiff(result);
    } catch {
      return EMPTY_COMMIT_FILES;
    }
  }, []);
  const scopeKey =
    commitSha && selectedRepoId
      ? JSON.stringify({
          commitSha,
          repoId: selectedRepoId,
          repoPath: selectedRepoPath,
        })
      : null;
  const resource = useAsyncResource({
    enabled: Boolean(scopeKey),
    fetcher: fetchCommitFiles,
    initialData: EMPTY_COMMIT_FILES,
    scopeKey,
  });

  return {
    files: resource.data.files,
    loading: resource.loading,
    totalStats: resource.data.totalStats,
  };
}
