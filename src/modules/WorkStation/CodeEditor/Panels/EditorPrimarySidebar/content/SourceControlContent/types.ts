/**
 * Types for SourceControlContent component
 */
import type { StashEntry } from "@src/api/http/git/types";
import type { SourceControlHistorySelection } from "@src/store/workstation/tabs";
import type { GitFile } from "@src/types/git/types";

export interface SourceControlContentProps {
  // File list props
  files: GitFile[];
  filteredFiles: GitFile[];
  selectedFileId: string;
  loading: boolean;
  error: string | null;
  onFileSelect: (fileId: string) => void;
  /**
   * When true, normal row clicks notify the parent without updating sidebar
   * selection. Used by All Changes so clicking a row scrolls the inline diff
   * while leaving the list free to scroll without a sticky selected row.
   */
  navigateWithoutSelecting?: boolean;
  /** Called when stage/unstage is clicked */
  onStageToggle?: (fileId: string, stage: boolean) => Promise<void>;
  /** Called when discard is clicked */
  onDiscard?: (fileId: string) => Promise<void>;
  /** Called when discarding multiple explicit files */
  onDiscardFiles?: (fileIds: string[]) => Promise<void>;

  // Bulk operations
  onStageAll?: () => Promise<void>;
  onUnstageAll?: () => Promise<void>;
  onDiscardAll?: () => Promise<void>;
  onOpenChanges?: () => void;
  onOpenStagedChanges?: () => void;

  // Commit props
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  onCommit: () => void;
  onCommitAndPush?: () => void;
  onCommitAndPublish?: () => void;
  onCommitAndSync?: () => void;
  onAmend?: () => void;
  commitLoading: boolean;
  stagedFilesCount: number;
  branchName?: string;

  // Generate commit message (AI)
  onGenerateCommitMessage?: () => void;
  generateCommitMessageLoading?: boolean;

  // Merge operation props
  /** Whether currently in a merge operation */
  isMerging?: boolean;
  /** Merge source branch name (e.g., "feat-conflict-a") */
  mergingBranch?: string;
  /** Continue merge after resolving conflicts */
  onContinueMerge?: () => void;

  // Search props
  searchQuery: string;
  onSearchChange: (query: string) => void;
  showFilter?: boolean;

  // View mode props
  viewMode?: "list-tree" | "list";
  /** Show only the stash category content. */
  showOnlyStashes?: boolean;
  /**
   * Section filter: which working-tree sections to render.
   *  - "uncommitted" (default): show Merge / Staged / Changes
   *  - "staged": show only the Staged section (Merge still shown when conflicts exist)
   *  - "unstaged": show only the Changes section (Merge still shown when conflicts exist)
   * Stashed/history are routed via separate surfaces and not handled here.
   */
  sectionFilter?: "uncommitted" | "staged" | "unstaged";

  // Merge conflict props
  /** Files with unresolved merge conflicts */
  conflictFiles?: GitFile[];
  /** Whether there are any unresolved merge conflicts */
  hasConflicts?: boolean;
  /** Called when user marks a conflict as resolved (stages the file) */
  onStageResolved?: (fileId: string) => Promise<void>;

  // Stash management props
  /** List of stashes */
  stashes?: StashEntry[];
  /** Whether any stash operation is in progress */
  stashOperationLoading?: boolean;
  /** Whether there are changes that can be stashed */
  hasChangesToStash?: boolean;
  /** Create a new stash */
  onStashPush?: (
    message?: string,
    includeUntracked?: boolean
  ) => Promise<boolean>;
  /** Apply a stash (keeps stash) */
  onStashApply?: (index: number) => Promise<boolean>;
  /** Pop a stash (applies and removes) */
  onStashPop?: (index: number) => Promise<boolean>;
  /** Drop a stash (removes) */
  onStashDrop?: (index: number) => Promise<boolean>;
  /** Renders a selected history node in the host Source Control pane. */
  onHistorySelectionChange?: (selection: SourceControlHistorySelection) => void;

  // Refresh callback
  /** Called to refresh git status */
  onRefresh?: () => void;

  // Sync props (for Sync Changes button)
  /** Number of local commits ahead of remote */
  ahead?: number;
  /** Number of commits behind remote */
  behind?: number;
  /** Callback to sync (pull + push) */
  onSync?: () => void;
  /** Whether sync operation is in progress */
  syncLoading?: boolean;
  /** Callback to pull only */
  onPull?: () => void;
  /** Whether pull operation is in progress */
  pullLoading?: boolean;
  /** Callback to push only */
  onPush?: () => void;
  /** Whether push operation is in progress */
  pushLoading?: boolean;
  /** Callback to fetch only */
  onFetch?: () => void;
  /** Whether fetch operation is in progress */
  fetchLoading?: boolean;

  // Repo identification (for diff API calls)
  /** Repository ID */
  repoId?: string;
  /** Repository filesystem path */
  repoPath?: string;

  // Publish props (for unpublished branches)
  /** Whether the current branch has an upstream (remote tracking branch) */
  hasUpstream?: boolean;
  /** Callback to publish branch (push with --set-upstream) */
  onPublish?: () => Promise<void>;
  /** Whether publish operation is in progress */
  publishLoading?: boolean;

  /** Tailwind bg class for sticky section/folder headers. Defaults to bg-workstation-bg. */
  stickyBgClass?: string;

  /**
   * When true, skip the in-pane loading placeholder. Used when a parent
   * overlay (e.g. scope-switch loading) already covers the changes area.
   */
  suppressLoadingPlaceholder?: boolean;
}
