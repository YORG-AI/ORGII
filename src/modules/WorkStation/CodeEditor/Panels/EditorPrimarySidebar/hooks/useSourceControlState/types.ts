/**
 * Types for useSourceControlState hook
 */
import type { StashEntry } from "@src/api/http/git/types";
import type { GitFile } from "@src/types/git/types";

export interface UseSourceControlStateOptions {
  /** Repository path */
  repoPath: string;
  /** Repository ID */
  repoId: string;
  /** Callback when a git file is selected (for showing diff in right panel) */
  onGitFileSelect?: (file: GitFile) => void;
  /** Load stash metadata only when the stash surface is selected. */
  autoLoadStashes?: boolean;
}

export interface SourceControlState {
  // File list
  files: GitFile[];
  filteredFiles: GitFile[];
  selectedFileId: string;
  loading: boolean;
  error: string | null;
  onFileSelect: (fileId: string) => void;
  onStageToggle: (fileId: string, stage: boolean) => Promise<void>;
  onDiscard: (fileId: string) => Promise<void>;
  onDiscardFiles: (fileIds: string[]) => Promise<void>;

  // Bulk operations
  onStageAll: () => Promise<void>;
  onUnstageAll: () => Promise<void>;
  onDiscardAll: () => Promise<void>;
  onOpenChanges: () => void;
  onOpenStagedChanges: () => void;

  // Search
  searchQuery: string;
  onSearchChange: (query: string) => void;

  // Commit
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  onCommit: () => void;
  onCommitAndPush?: () => void;
  onCommitAndPublish?: () => void;
  onCommitAndSync?: () => void;
  onAmend: () => void;
  commitLoading: boolean;
  generateCommitMessageLoading: boolean;
  onGenerateCommitMessage: () => void;
  stagedFilesCount: number;
  branchName?: string;

  // Sync (pull + push)
  /** Number of local commits ahead of remote */
  ahead: number;
  /** Number of commits behind remote */
  behind: number;
  /** Callback to sync (pull + push) */
  onSync: () => void;
  /** Whether sync operation is in progress */
  syncLoading: boolean;
  /** Callback to pull only */
  onPull: () => void;
  /** Whether pull operation is in progress */
  pullLoading: boolean;
  /** Callback to push only */
  onPush: () => void;
  /** Whether push operation is in progress */
  pushLoading: boolean;
  /** Callback to fetch only */
  onFetch: () => void;
  /** Whether fetch operation is in progress */
  fetchLoading: boolean;

  // Publish (for unpublished branches)
  /** Whether the current branch has an upstream (remote tracking branch) */
  hasUpstream: boolean;
  /** Callback to publish branch (push with --set-upstream) */
  onPublish: () => Promise<void>;
  /** Whether publish operation is in progress */
  publishLoading: boolean;

  // Merge conflicts
  /** Files with merge conflicts (status === "conflict") */
  conflictFiles: GitFile[];
  /** Whether there are any unresolved merge conflicts */
  hasConflicts: boolean;
  /** Stage a resolved conflict file */
  onStageResolved: (fileId: string) => Promise<void>;

  // Merge operation state
  /** Whether currently in a merge operation */
  isMerging: boolean;
  /** Merge source branch name */
  mergingBranch?: string;
  /** Continue merge after resolving conflicts */
  onContinueMerge: () => void;

  // Stash management
  /** List of stashes */
  stashes: StashEntry[];
  /** Whether any stash operation is in progress */
  stashOperationLoading: boolean;
  /** Number of stashes */
  stashCount: number;
  /** Create a new stash */
  onStashPush: (
    message?: string,
    includeUntracked?: boolean
  ) => Promise<boolean>;
  /** Apply a stash (keeps stash) */
  onStashApply: (index: number) => Promise<boolean>;
  /** Pop a stash (applies and removes) */
  onStashPop: (index: number) => Promise<boolean>;
  /** Drop a stash (removes) */
  onStashDrop: (index: number) => Promise<boolean>;
  /** Whether there are changes that can be stashed */
  hasChangesToStash: boolean;

  // Pull request
  prUrl?: string;
  prCreating?: boolean;
  prReadyToCreate?: boolean;
  prEligible?: boolean;
  autoCreatePr?: boolean;
  onCreatePr?: () => Promise<{ url?: string; error?: string }>;
}

export interface UseSourceControlStateResult {
  /** Unified state for Source Control panel */
  state: SourceControlState;
  /** Function to refresh git status */
  refresh: () => Promise<void>;
  /** Whether the state is loading */
  loading: boolean;
  /** Timestamp of last successful refresh (milliseconds since epoch) */
  lastRefreshTime: number | null;
}
