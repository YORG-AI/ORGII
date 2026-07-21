import { readTextFile } from "@tauri-apps/plugin-fs";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { fetchNumstatMap } from "@src/api/http/git/diff";
import { createLogger } from "@src/hooks/logger";
import {
  loadWorkingTreeDiff,
  releaseWorkingTreeDiff,
} from "@src/services/git/workingTreeDiffResource";
import type { GitFile } from "@src/types/git/types";
import { decodeOctalPath } from "@src/util/file/pathUtils";

import {
  countContentLines,
  getDiffLookupKeys,
  getEffectiveDiffStats,
  getEffectiveRepoPath,
  getRelativePath,
} from "./utils";

const log = createLogger("AllChangesView");

interface UseAllChangesFilesOptions {
  files: GitFile[];
  repoId?: string;
  repoPath?: string;
}

interface UseAllChangesFilesResult {
  filesWithDiffs: GitFile[];
  sortedFiles: GitFile[];
  loadContentForFile: (file: GitFile) => Promise<void>;
  releaseContentForFile: (path: string) => void;
  getSectionRef: (path: string) => React.RefObject<HTMLDivElement | null>;
}

export function useAllChangesFiles({
  files,
  repoId,
  repoPath,
}: UseAllChangesFilesOptions): UseAllChangesFilesResult {
  const [filesWithDiffs, setFilesWithDiffs] = useState<GitFile[]>([]);

  const statsLoadedPathsRef = useRef<Set<string>>(new Set());
  const contentLoadedPathsRef = useRef<Set<string>>(new Set());
  const inFlightContentRef = useRef<Set<string>>(new Set());
  const activeContentPathsRef = useRef<Set<string>>(new Set());
  const previousFilesKeyRef = useRef("");
  const isLoadingStatsRef = useRef(false);
  const sectionRefs = useRef(
    new Map<string, React.RefObject<HTMLDivElement | null>>()
  );

  const filesKey = useMemo(
    () =>
      files
        .map((file) => file.path)
        .sort()
        .join("|"),
    [files]
  );

  // ------------------------------------------------------------
  // Stats-only batch load (cheap — no file content over the wire)
  // ------------------------------------------------------------
  const loadStatsForFiles = useCallback(
    async (filesToLoad: GitFile[]) => {
      if (!repoPath || filesToLoad.length === 0) return;
      if (isLoadingStatsRef.current) return;

      // Note: `useGitFiles` seeds every file with `additions: 0, deletions: 0`
      // (numeric, not undefined), so we cannot use those fields to detect
      // "stats not yet fetched". Gate purely on `statsLoadedPathsRef`.
      const unloadedFiles = filesToLoad.filter(
        (file) => !statsLoadedPathsRef.current.has(file.path)
      );
      if (unloadedFiles.length === 0) return;

      isLoadingStatsRef.current = true;

      try {
        // Group files by their effective repo root so worktree files are
        // fetched from the correct directory, not the host repo.
        const groups = new Map<string, GitFile[]>();
        for (const file of unloadedFiles) {
          const effectivePath = getEffectiveRepoPath(file, repoPath);
          const group = groups.get(effectivePath) ?? [];
          group.push(file);
          groups.set(effectivePath, group);
        }

        // Header badges only need numstat. Full old/new content is fetched
        // separately when a section expands.
        const allStats = await Promise.all(
          Array.from(groups.entries()).map(([groupRepoPath, groupFiles]) => {
            const resolvedRepoId = repoId ?? groupRepoPath;
            return fetchNumstatMap(resolvedRepoId, groupRepoPath).then(
              (stats) => ({ groupRepoPath, groupFiles, stats })
            );
          })
        );

        const statsMap = new Map<
          string,
          { additions: number; deletions: number }
        >();
        for (const { groupRepoPath, groupFiles, stats } of allStats) {
          for (const [rawPath, value] of stats) {
            const decodedPath = decodeOctalPath(rawPath);
            statsMap.set(`${groupRepoPath}\0${rawPath}`, value);
            statsMap.set(`${groupRepoPath}\0${decodedPath}`, value);
            statsMap.set(
              `${groupRepoPath}\0${getRelativePath(decodedPath, groupRepoPath)}`,
              value
            );
          }
          for (const file of groupFiles) {
            statsLoadedPathsRef.current.add(file.path);
          }
        }

        setFilesWithDiffs((prev) =>
          prev.map((file) => {
            const effectivePath = getEffectiveRepoPath(file, repoPath);
            const stats = getDiffLookupKeys(file.path, effectivePath)
              .map((key) => statsMap.get(`${effectivePath}\0${key}`))
              .find((value) => value !== undefined);
            return stats
              ? {
                  ...file,
                  additions: stats.additions,
                  deletions: stats.deletions,
                }
              : file;
          })
        );
      } catch (error) {
        log.error("[AllChangesView] Failed to load stats:", error);
      } finally {
        isLoadingStatsRef.current = false;
      }
    },
    [repoId, repoPath]
  );

  // ------------------------------------------------------------
  // Single-file content load (triggered on section expand)
  // ------------------------------------------------------------
  const loadContentForFile = useCallback(
    async (file: GitFile) => {
      if (!repoPath) return;
      activeContentPathsRef.current.add(file.path);
      if (file.oldContent !== undefined || file.newContent !== undefined)
        return;
      if (contentLoadedPathsRef.current.has(file.path)) return;
      if (inFlightContentRef.current.has(file.path)) return;

      const effectivePath = getEffectiveRepoPath(file, repoPath);
      const resolvedRepoId = repoId ?? effectivePath;

      inFlightContentRef.current.add(file.path);

      try {
        const diff = await loadWorkingTreeDiff({
          repoId: resolvedRepoId,
          repoPath: effectivePath,
          file,
        });

        if (diff) {
          if (!activeContentPathsRef.current.has(file.path)) return;
          contentLoadedPathsRef.current.add(file.path);
          statsLoadedPathsRef.current.add(file.path);
          const { oldContent, newContent } = diff;
          const { additions, deletions } = getEffectiveDiffStats(
            file,
            { insertions: diff.additions, deletions: diff.deletions },
            oldContent,
            newContent
          );
          setFilesWithDiffs((prev) =>
            prev.map((entry) =>
              entry.path === file.path
                ? { ...entry, oldContent, newContent, additions, deletions }
                : entry
            )
          );
        } else if (file.status === "added") {
          const absolutePath = file.path.startsWith("/")
            ? file.path
            : `${effectivePath}/${file.path}`;
          try {
            const content = await readTextFile(absolutePath);
            if (!activeContentPathsRef.current.has(file.path)) return;
            contentLoadedPathsRef.current.add(file.path);
            statsLoadedPathsRef.current.add(file.path);
            const additions = countContentLines(content);
            setFilesWithDiffs((prev) =>
              prev.map((entry) =>
                entry.path === file.path
                  ? {
                      ...entry,
                      oldContent: "",
                      newContent: content,
                      additions,
                      deletions: 0,
                    }
                  : entry
              )
            );
          } catch (error) {
            log.error(
              "[AllChangesView] Untracked-file disk read failed:",
              file.path,
              absolutePath,
              error
            );
          }
        }
      } catch (error) {
        log.error("[AllChangesView] Failed to load content:", error);
      } finally {
        inFlightContentRef.current.delete(file.path);
      }
    },
    [repoId, repoPath]
  );

  const releaseContentForFile = useCallback(
    (path: string) => {
      activeContentPathsRef.current.delete(path);
      contentLoadedPathsRef.current.delete(path);
      const file = filesWithDiffs.find((entry) => entry.path === path);
      if (file && repoPath) {
        const effectivePath = getEffectiveRepoPath(file, repoPath);
        releaseWorkingTreeDiff({
          repoId: repoId ?? effectivePath,
          repoPath: effectivePath,
          file,
        });
      }
      setFilesWithDiffs((prev) =>
        prev.map((file) =>
          file.path === path
            ? { ...file, oldContent: undefined, newContent: undefined }
            : file
        )
      );
    },
    [filesWithDiffs, repoId, repoPath]
  );

  // Sync files state — preserve loaded diffs on polling updates
  useEffect(() => {
    if (previousFilesKeyRef.current !== filesKey) {
      previousFilesKeyRef.current = filesKey;
      statsLoadedPathsRef.current.clear();
      contentLoadedPathsRef.current.clear();
      inFlightContentRef.current.clear();
      activeContentPathsRef.current.clear();
      setFilesWithDiffs(files);
    } else {
      setFilesWithDiffs((prev) => {
        const prevMap = new Map(prev.map((file) => [file.path, file]));
        return files.map((file) => {
          const previousFile = prevMap.get(file.path);
          if (!previousFile) return file;
          // Prefer the previously-loaded data over the freshly-polled
          // one. `useGitFiles` re-emits every file with `additions: 0,
          // deletions: 0, oldContent: undefined` on each git-status
          // poll; if we naively merged with `file.additions ?? previousFile.additions`
          // the numeric `0` would always win and wipe our loaded stats
          // back to zero.
          const previousLoadedStats = statsLoadedPathsRef.current.has(
            file.path
          );
          return {
            ...file,
            oldContent:
              previousFile.oldContent !== undefined
                ? previousFile.oldContent
                : file.oldContent,
            newContent:
              previousFile.newContent !== undefined
                ? previousFile.newContent
                : file.newContent,
            additions: previousLoadedStats
              ? previousFile.additions
              : file.additions,
            deletions: previousLoadedStats
              ? previousFile.deletions
              : file.deletions,
          };
        });
      });
    }

    loadStatsForFiles(files);
  }, [files, filesKey, loadStatsForFiles]);

  const sortedFiles = useMemo(() => {
    return [...filesWithDiffs].sort((fileA, fileB) =>
      fileA.path.localeCompare(fileB.path)
    );
  }, [filesWithDiffs]);

  const getSectionRef = useCallback((path: string) => {
    const existingRef = sectionRefs.current.get(path);
    if (existingRef) return existingRef;

    const nextRef = React.createRef<HTMLDivElement>();
    sectionRefs.current.set(path, nextRef);
    return nextRef;
  }, []);

  return {
    filesWithDiffs,
    sortedFiles,
    loadContentForFile,
    releaseContentForFile,
    getSectionRef,
  };
}
