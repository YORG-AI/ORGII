/**
 * useCommitFiles Hook
 *
 * Lazily fetches changed files for a git commit message.
 * Only triggers when the message is a commit (id starts with "git-commit-").
 * Caches results by commit SHA to avoid re-fetching.
 */
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";

import { getGitCommitDiff } from "@src/api/http/git/diff";
import type {
  CommitDiffResult,
  GitFileDiffStatus,
} from "@src/api/http/git/types";
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

export function useCommitFiles(messageId: string): UseCommitFilesResult {
  const selectedRepoId = useAtomValue(selectedRepoIdAtom);
  const selectedRepoPath = useAtomValue(selectedRepoPathAtom);
  const [files, setFiles] = useState<CommitFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [totalStats, setTotalStats] = useState<{
    additions: number;
    deletions: number;
  } | null>(null);

  const cacheRef = useRef<Map<string, CommitDiffResult>>(new Map());

  const isCommit = messageId.startsWith("git-commit-");
  const commitSha = isCommit ? messageId.replace("git-commit-", "") : null;

  useEffect(() => {
    if (!commitSha || !selectedRepoId) {
      setFiles([]);
      setTotalStats(null);
      return;
    }

    // Check cache
    const cached = cacheRef.current.get(commitSha);
    if (cached) {
      setFiles(
        cached.files.map((file) => ({
          path: decodeOctalPath(file.file_path),
          status: file.status,
          additions: file.insertions ?? 0,
          deletions: file.deletions ?? 0,
        }))
      );
      setTotalStats({
        additions: cached.stats?.insertions ?? 0,
        deletions: cached.stats?.deletions ?? 0,
      });
      return;
    }

    let cancelled = false;
    setLoading(true);

    const fetchDiff = async () => {
      try {
        const result = await getGitCommitDiff({
          repo_id: selectedRepoId,
          repo_path: selectedRepoPath || undefined,
          commit_sha: commitSha,
          context_lines: 0, // We only need stats, not full diff
        });
        if (cancelled || !result) return;

        // Cache with eviction
        if (cacheRef.current.size >= MAX_CACHE_SIZE) {
          const firstKey = cacheRef.current.keys().next().value;
          if (firstKey) cacheRef.current.delete(firstKey);
        }
        cacheRef.current.set(commitSha, result);

        setFiles(
          result.files.map((file) => ({
            path: decodeOctalPath(file.file_path),
            status: file.status,
            additions: file.insertions ?? 0,
            deletions: file.deletions ?? 0,
          }))
        );
        setTotalStats({
          additions: result.stats?.insertions ?? 0,
          deletions: result.stats?.deletions ?? 0,
        });
      } catch {
        // Silently ignore — commit may not be accessible
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchDiff();

    return () => {
      cancelled = true;
    };
  }, [commitSha, selectedRepoId, selectedRepoPath]);

  return { files, loading, totalStats };
}
