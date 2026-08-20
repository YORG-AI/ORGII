/**
 * Hook for managing git file list and status fetching
 *
 * Architecture:
 * - Reads currentGitStatus from GitStatusContext
 * - Does NOT listen to Rust events directly (avoids duplicate listeners)
 * - Uses forceRefresh() from GitStatusContext for manual refresh
 * - Merges diff content from local state with file list from currentGitStatus
 *
 * GitStatusContext is the SINGLE SOURCE OF TRUTH for git status updates.
 * Diff content is stored locally and merged with the derived file list.
 */
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useGitStatus } from "@src/contexts/git";
import type { GitFile } from "@src/types/git/types";
import type { GitRepositoryStatus } from "@src/types/session/steps";

import { areBaseFileListsEqual, deriveBaseFiles } from "./gitFilesDerivation";

/**
 * Derive the base file list from a git status, returning the SAME array
 * reference when a newly-fetched status describes a byte-identical working
 * tree. Background status pings replace the `gitStatus` object on every poll;
 * without this stabilization each poll cascades a fresh `files` reference into
 * `useSourceControlState`'s state memo even when nothing changed.
 *
 * Mirrors the ref-cached `useMemo` pattern used by `useEventStoreSelector`.
 */
function useStableBaseFiles(
  gitStatus: GitRepositoryStatus | null,
  selectedRepoId: string | null
): GitFile[] {
  const prevRef = useRef<GitFile[]>([]);
  return useMemo(() => {
    const next =
      !selectedRepoId || !gitStatus
        ? []
        : deriveBaseFiles(gitStatus.working_directory?.files || []);

    // The equality gate compares every identity-bearing field, so any real
    // working-tree change yields a fresh array and this can never stick stale.
    if (areBaseFileListsEqual(prevRef.current, next)) {
      return prevRef.current;
    }
    prevRef.current = next;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitStatus, selectedRepoId]);
}

export interface UseGitFilesOptions {
  selectedRepoId: string | null;
  repoPath?: string;
  autoLoad?: boolean;
}

export interface UseGitFilesResult {
  files: GitFile[];
  setFiles: Dispatch<SetStateAction<GitFile[]>>;
  loading: boolean;
  error: string | null;
  fetchGitStatus: () => Promise<void>;
  hasInitialSelectionRef: MutableRefObject<boolean>;
}

/**
 * State for file overrides cache - stores repoId to invalidate stale data
 * Includes both diff content and UI state like `staged`
 */
interface FileOverridesState {
  repoId: string | null;
  map: Map<string, Partial<GitFile>>;
}

export function useGitFiles(options: UseGitFilesOptions): UseGitFilesResult {
  const { selectedRepoId, autoLoad = true } = options;

  const [error, setError] = useState<string | null>(null);

  // Store file overrides (diff content + staged state) with its associated repoId
  // When repoId changes, the old data is considered stale and ignored in useMemo
  const [overridesState, setOverridesState] = useState<FileOverridesState>({
    repoId: null,
    map: new Map(),
  });

  // Ref to track if initial file selection has been done
  const hasInitialSelectionRef = useRef(false);

  const { currentGitStatus: gitStatus, forceRefresh, loading } = useGitStatus();

  // Derive base files from gitStatus, reusing the prior array reference when a
  // new gitStatus object describes a byte-identical working tree (see
  // useStableBaseFiles).
  const baseFiles = useStableBaseFiles(gitStatus, selectedRepoId);

  // Merge base files with overrides (diff content + staged state) from local state
  // If repoId doesn't match, the cached data is stale and ignored
  const files = useMemo(() => {
    // Only use overrides if it matches current repo
    const overridesMap =
      overridesState.repoId === selectedRepoId ? overridesState.map : new Map();

    if (overridesMap.size === 0) {
      return baseFiles;
    }

    return baseFiles.map((file) => {
      const overrides = overridesMap.get(file.id);
      if (overrides) {
        return { ...file, ...overrides };
      }
      return file;
    });
  }, [baseFiles, selectedRepoId, overridesState]);

  // setFiles implementation that updates overrides (diff content + staged state)
  const setFiles: Dispatch<SetStateAction<GitFile[]>> = useCallback(
    (updater) => {
      // Handle both function and direct value updates
      const newFiles = typeof updater === "function" ? updater(files) : updater;

      // Get current map only if it's for the same repo
      const currentMap =
        overridesState.repoId === selectedRepoId
          ? overridesState.map
          : new Map();

      // Extract override updates (diff content + staged changes)
      const newOverrides = new Map<string, Partial<GitFile>>();
      const processedFileIds = new Set<string>();
      let hasChanges = false;

      for (const file of newFiles) {
        const baseFile = baseFiles.find((base) => base.id === file.id);
        if (!baseFile) continue;

        // Mark this file as processed
        processedFileIds.add(file.id);

        const existing = currentMap.get(file.id);

        // Build the new override for this file
        const newOverride: Partial<GitFile> = {};

        // Handle staged: only store if different from base
        if (file.staged !== baseFile.staged) {
          newOverride.staged = file.staged;
        } else if (existing?.staged !== undefined) {
          // Clearing existing staged override (now matches base)
          hasChanges = true;
        }

        // Handle diff content: preserve if present
        if (file.oldContent !== undefined) {
          newOverride.oldContent = file.oldContent;
          newOverride.newContent = file.newContent;
          newOverride.additions = file.additions;
          newOverride.deletions = file.deletions;
        } else if (existing?.oldContent !== undefined) {
          // Preserve existing diff content
          newOverride.oldContent = existing.oldContent;
          newOverride.newContent = existing.newContent;
          newOverride.additions = existing.additions;
          newOverride.deletions = existing.deletions;
        }

        // Store if there's anything to store
        if (Object.keys(newOverride).length > 0) {
          newOverrides.set(file.id, newOverride);
        }

        // Check if changed from existing
        if (
          !existing ||
          existing.staged !== newOverride.staged ||
          existing.oldContent !== newOverride.oldContent
        ) {
          hasChanges = true;
        }
      }

      // Only preserve existing overrides for files NOT processed above
      // (e.g., files that were removed from the list but might come back)
      for (const [fileId, content] of currentMap) {
        if (
          !processedFileIds.has(fileId) &&
          baseFiles.some((base) => base.id === fileId)
        ) {
          newOverrides.set(fileId, content);
        }
      }

      // Only update if there are actual changes
      if (hasChanges || newOverrides.size !== currentMap.size) {
        setOverridesState({ repoId: selectedRepoId, map: newOverrides });
      }
    },
    [files, baseFiles, selectedRepoId, overridesState]
  );

  // Delegates to GitStatusContext
  const fetchGitStatus = useCallback(async () => {
    if (!selectedRepoId) {
      setError("No repo selected");
      return;
    }

    await forceRefresh();
  }, [selectedRepoId, forceRefresh]);

  // Reset initial selection flag when repo changes
  useEffect(() => {
    hasInitialSelectionRef.current = false;
  }, [selectedRepoId]);

  // On mount, trigger initial refresh if autoLoad is enabled
  useEffect(() => {
    if (autoLoad && selectedRepoId) {
      forceRefresh();
    }
  }, [autoLoad, selectedRepoId, forceRefresh]);

  return {
    files,
    setFiles,
    loading,
    error,
    fetchGitStatus,
    hasInitialSelectionRef,
  };
}
