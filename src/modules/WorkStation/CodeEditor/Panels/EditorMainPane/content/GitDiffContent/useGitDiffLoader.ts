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
import { loadWorkingTreeDiff } from "@src/services/git/workingTreeDiffResource";
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

export function useGitDiffLoader({
  gitFile,
  repoPath,
}: UseGitDiffLoaderOptions): UseGitDiffLoaderResult {
  const [fetchedDiff, setFetchedDiff] = useState<FetchedDiff | null>(null);
  const [selfFetching, setSelfFetching] = useState(false);

  // Reset cached diff when file path changes.
  useEffect(() => {
    setFetchedDiff(null);
  }, [gitFile?.path]);

  useEffect(() => {
    if (!gitFile || !repoPath) return;
    if (gitFile.oldContent !== undefined) return;
    // Timeline diffs are keyed by tab id and are populated synchronously by
    // `handleTimelineCommitClick`; a working-tree fetch would be wrong.
    if (gitFile.id?.startsWith("timeline:")) return;
    if (fetchedDiff?.path === gitFile.path) return;

    let cancelled = false;
    setSelfFetching(true);
    loadWorkingTreeDiff({
      repoPath,
      file: gitFile,
    })
      .then((diff) => {
        if (cancelled) return;
        if (!diff) {
          setFetchedDiff({
            path: gitFile.path,
            oldContent: "",
            newContent: "",
            additions: 0,
            deletions: 0,
          });
          return;
        }
        setFetchedDiff({
          path: gitFile.path,
          oldContent: diff.oldContent,
          newContent: diff.newContent,
          additions: diff.additions,
          deletions: diff.deletions,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        log.error("[GitDiffContent] Self-fetch failed:", error);
        setFetchedDiff({
          path: gitFile.path,
          oldContent: "",
          newContent: "",
          additions: 0,
          deletions: 0,
        });
      })
      .finally(() => {
        if (!cancelled) setSelfFetching(false);
      });

    return () => {
      cancelled = true;
    };
    // We intentionally depend on the narrow set of fields that determine
    // whether a fetch is needed, not on the full gitFile reference, to avoid
    // re-firing whenever the parent passes a new object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    gitFile?.path,
    gitFile?.oldContent,
    gitFile?.id,
    gitFile?.original_path,
    gitFile?.status,
    gitFile?.staged,
    repoPath,
    fetchedDiff?.path,
  ]);

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
