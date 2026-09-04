/**
 * Global Git Status Atoms
 *
 * Centralized state management for git repository status and suggested actions.
 *
 * ARCHITECTURE (Dec 30, 2025):
 * - Primary atoms: Updated by GitStatusContext
 * - Real-time updates via Rust backend file watcher events
 *
 * FILE TREE DECORATIONS (Jan 21, 2026):
 * - gitFileStatusMapAtom: Derived map for O(1) file status lookup
 * - Used by tree views for reliable git status display
 * - Survives hot reload, no timing issues
 */
import { atom } from "jotai";

import { type GitFileStatus, normalizeGitStatus } from "@src/config/gitStatus";
import { selectedRepoIdAtom, selectedRepoPathAtom } from "@src/store/repo";
import {
  GitRepositoryStatus,
  GitSuggestedAction,
} from "@src/types/session/steps";

// ============================================
// Primary Atoms (Updated by GitStatusContext)
// ============================================

/**
 * Current git status for the selected repository
 * Updated by GitStatusContext
 */
export const gitStatusAtom = atom<GitRepositoryStatus | null>(null);
gitStatusAtom.debugLabel = "gitStatusAtom";

export interface ScopedGitStatusState {
  repoId: string;
  repoPath: string;
  status: GitRepositoryStatus;
}

export const scopedGitStatusAtom = atom<ScopedGitStatusState | null>(null);
scopedGitStatusAtom.debugLabel = "scopedGitStatusAtom";

export const currentGitStatusAtom = atom<GitRepositoryStatus | null>((get) => {
  const scopedStatus = get(scopedGitStatusAtom);
  const selectedRepoId = get(selectedRepoIdAtom);
  const selectedRepoPath = get(selectedRepoPathAtom) || null;

  if (
    !scopedStatus ||
    scopedStatus.repoId !== selectedRepoId ||
    scopedStatus.repoPath !== selectedRepoPath
  ) {
    return null;
  }

  return scopedStatus.status;
});
currentGitStatusAtom.debugLabel = "currentGitStatusAtom";

/**
 * Suggested git action based on current status
 * Updated by GitStatusContext
 */
export const gitSuggestedActionAtom = atom<GitSuggestedAction | null>(null);
gitSuggestedActionAtom.debugLabel = "gitSuggestedActionAtom";

// ============================================
// File Tree Decoration Atoms (Jan 21, 2026)
// ============================================

/**
 * Git file info for tree decoration
 */
export interface GitFileInfo {
  status: GitFileStatus;
  staged: boolean;
}

/**
 * Derived atom: Map of relative file path → git status info
 * Used for O(1) lookup when rendering file tree nodes
 *
 * Benefits over merging into tree:
 * - Survives hot reload (derived from currentGitStatusAtom)
 * - No timing issues (render-time lookup)
 * - Automatically updates when the scoped current git status changes
 * - Works with lazy-loaded directories
 */
export const gitFileStatusMapAtom = atom<Map<string, GitFileInfo>>((get) => {
  const gitStatus = get(currentGitStatusAtom);
  const statusMap = new Map<string, GitFileInfo>();

  if (!gitStatus?.working_directory?.files) {
    return statusMap;
  }

  for (const file of gitStatus.working_directory.files) {
    // Normalize path (remove leading slash if present)
    const relativePath = file.path.startsWith("/")
      ? file.path.substring(1)
      : file.path;

    statusMap.set(relativePath, {
      status: normalizeGitStatus(file.status),
      staged: file.staged,
    });
  }

  return statusMap;
});
gitFileStatusMapAtom.debugLabel = "gitFileStatusMapAtom";

/**
 * Priority order for folder aggregate status
 * Higher number = higher priority (shown when folder has multiple statuses)
 */
export const STATUS_PRIORITY: Record<string, number> = {
  conflict: 5,
  deleted: 4,
  renamed: 3,
  modified: 2,
  added: 1,
};

/**
 * Derived atom: Pre-computed map of folder path → aggregate status
 *
 * Computed once when gitFileStatusMapAtom changes, not on every folder render.
 * Provides O(1) lookup for folder status instead of O(n) iteration.
 *
 * Algorithm:
 * - For each changed file, update all parent folders with highest priority status
 * - Single pass: O(n × d) where n = files, d = average depth
 * - Much faster than O(n) lookup per folder render
 *
 * Example:
 * - File: "src/components/Button.tsx" (modified)
 * - Updates: "src" → modified, "src/components" → modified
 *
 * @see WorkStation tree views for usage
 */
export const gitFolderStatusMapAtom = atom<Map<string, GitFileStatus>>(
  (get) => {
    const statusMap = get(gitFileStatusMapAtom);
    const folderStatusMap = new Map<string, GitFileStatus>();

    // Build folder status map in single pass
    // For each file, update all its parent folders
    for (const [filePath, fileInfo] of statusMap) {
      const parts = filePath.split("/");

      // Update all parent folders for this file
      // Example: "src/components/Button.tsx" → ["src", "src/components"]
      for (let partIndex = 0; partIndex < parts.length - 1; partIndex++) {
        const folderPath = parts.slice(0, partIndex + 1).join("/");

        // Get current status for this folder (if any)
        const currentStatus = folderStatusMap.get(folderPath);
        const currentPriority = currentStatus
          ? STATUS_PRIORITY[currentStatus] || 0
          : 0;
        const newPriority = STATUS_PRIORITY[fileInfo.status] || 0;

        // Update folder if this file has higher priority status
        if (newPriority > currentPriority) {
          folderStatusMap.set(folderPath, fileInfo.status);
        }
      }
    }

    return folderStatusMap;
  }
);
gitFolderStatusMapAtom.debugLabel = "gitFolderStatusMapAtom";

// ============================================
// Multi-Root Workspace Git Status
// ============================================

/**
 * Per-workspace-folder git status map.
 * Keyed by folder path → full GitRepositoryStatus.
 * Updated when workspace folders have independent git repos.
 */
export const workspaceGitStatusMapAtom = atom<Map<string, GitRepositoryStatus>>(
  new Map()
);
workspaceGitStatusMapAtom.debugLabel = "workspaceGitStatusMapAtom";

/**
 * Derived: merged file status map across all workspace folders.
 * Keys are absolute file paths (not relative) for multi-root disambiguation.
 */
export const workspaceFileStatusMapAtom = atom<Map<string, GitFileInfo>>(
  (get) => {
    const wsStatusMap = get(workspaceGitStatusMapAtom);
    const mergedMap = new Map<string, GitFileInfo>();

    for (const [folderPath, status] of wsStatusMap) {
      if (!status?.working_directory?.files) continue;

      for (const file of status.working_directory.files) {
        const relativePath = file.path.startsWith("/")
          ? file.path.substring(1)
          : file.path;
        const absolutePath = `${folderPath}/${relativePath}`;
        mergedMap.set(absolutePath, {
          status: normalizeGitStatus(file.status),
          staged: file.staged,
        });
      }
    }

    return mergedMap;
  }
);
workspaceFileStatusMapAtom.debugLabel = "workspaceFileStatusMapAtom";

/**
 * Derived: folder aggregate status map across all workspace folders.
 * Keys are absolute folder paths for multi-root disambiguation.
 * Same algorithm as gitFolderStatusMapAtom but operating on absolute paths.
 */
export const workspaceFolderStatusMapAtom = atom<Map<string, GitFileStatus>>(
  (get) => {
    const fileStatusMap = get(workspaceFileStatusMapAtom);
    const folderStatusMap = new Map<string, GitFileStatus>();

    for (const [filePath, fileInfo] of fileStatusMap) {
      const parts = filePath.split("/");
      for (let partIndex = 1; partIndex < parts.length - 1; partIndex++) {
        const folderPath = parts.slice(0, partIndex + 1).join("/");
        const currentStatus = folderStatusMap.get(folderPath);
        const currentPriority = currentStatus
          ? STATUS_PRIORITY[currentStatus] || 0
          : 0;
        const newPriority = STATUS_PRIORITY[fileInfo.status] || 0;
        if (newPriority > currentPriority) {
          folderStatusMap.set(folderPath, fileInfo.status);
        }
      }
    }

    return folderStatusMap;
  }
);
workspaceFolderStatusMapAtom.debugLabel = "workspaceFolderStatusMapAtom";

// ============================================
// Git Fetch Origin State
// ============================================

export type GitFetchOriginStatus = "idle" | "fetching" | "up-to-date" | "error";

export interface GitFetchOriginState {
  status: GitFetchOriginStatus;
  repoId: string | null;
  message?: string;
  lastFetchedAt?: Date;
}

/**
 * State for git fetch origin operations
 * Used to show "Fetching origin..." / "Up to date" in toolbar
 */
export const gitFetchOriginStateAtom = atom<GitFetchOriginState>({
  status: "idle",
  repoId: null,
});
gitFetchOriginStateAtom.debugLabel = "gitFetchOriginStateAtom";

/**
 * Computed atom: whether fetch origin indicator should be visible
 */
export const gitFetchOriginVisibleAtom = atom((get) => {
  const state = get(gitFetchOriginStateAtom);
  return state.status !== "idle";
});
gitFetchOriginVisibleAtom.debugLabel = "gitFetchOriginVisibleAtom";

/**
 * Computed atom: whether there are any actionable suggestions
 */
export const hasGitSuggestionsAtom = atom((get) => {
  const gitStatus = get(currentGitStatusAtom);

  if (!gitStatus) {
    return false;
  }

  const hasUncommittedChanges =
    (gitStatus.working_directory?.files?.length ?? 0) > 0;
  const hasAheadCommits = (gitStatus.branch_ahead_behind?.ahead ?? 0) > 0;
  const hasBehindCommits = (gitStatus.branch_ahead_behind?.behind ?? 0) > 0;
  const hasConflicts = gitStatus.do_conflicted_files_exist;
  const needsPublish = !gitStatus.current_upstream_branch;

  return (
    hasUncommittedChanges ||
    hasAheadCommits ||
    hasBehindCommits ||
    hasConflicts ||
    needsPublish
  );
});
hasGitSuggestionsAtom.debugLabel = "hasGitSuggestionsAtom";
