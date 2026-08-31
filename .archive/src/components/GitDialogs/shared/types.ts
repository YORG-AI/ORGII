/**
 * Shared types for Git Dialogs
 * All dialogs now use native Tauri system dialogs
 */

// ============================================
// Dialog Result Types
// ============================================

export type PullConflictResult = "stash_pull" | "discard_pull" | "cancel";

export type PushRejectedResult = "pull_push" | "force" | "cancel";

export type DetachedHeadResult = "create_branch" | "continue" | "cancel";

export type ProtectedBranchResult = "create_pr" | "cancel";

export type LargePushResult = "push" | "cancel";

export type RebaseConflictResult = "resolve" | "abort" | "cancel";

export type RemoteBranchDeletedResult =
  | "switch"
  | "delete_local"
  | "keep"
  | "cancel";

// ============================================
// Dialog Options Types
// ============================================

export interface PullConflictOptions {
  branchName?: string;
  remoteName?: string;
  conflictingFiles?: string[];
}

export interface PushRejectedOptions {
  branchName?: string;
  remoteName?: string;
  behindCount?: number;
}

export interface DetachedHeadOptions {
  commitHash?: string;
  suggestedBranchName?: string;
}

export interface ProtectedBranchOptions {
  branchName?: string;
  remoteName?: string;
}

export interface LargePushOptions {
  commitCount: number;
  branchName?: string;
  remoteName?: string;
}

export interface RebaseConflictOptions {
  targetBranch?: string;
  currentStep?: number;
  totalSteps?: number;
  conflictingFiles?: string[];
  /** Operation type: "rebase" or "merge" */
  operationType?: "rebase" | "merge";
}

export interface RemoteBranchDeletedOptions {
  branchName?: string;
  remoteName?: string;
  suggestedBranches?: string[];
}
