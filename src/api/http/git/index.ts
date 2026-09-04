/**
 * Git API - Rust backend
 *
 * Rust HTTP Server (port 13847):
 * - Primary backend for all git operations using git2 library
 * - Fast for: status, current branch, diff parsing, blame, commit diffs
 * - Branch listing, ahead/behind, default branch detection
 */
// Import all functions for building the gitApi object
import { getGitBlame } from "./blame";
import {
  gitCheckout,
  gitCreateBranch,
  gitDeleteBranch,
  gitRenameBranch,
} from "./branchOps";
import {
  getGitAheadBehind,
  getGitBranches,
  getGitCurrentBranch,
  getGitCurrentBranchName,
  getGitDefaultBranch,
} from "./branches";
import {
  gitCherryPick,
  gitCherryPickAbort,
  gitCherryPickContinue,
} from "./cherryPick";
import { clearStatusCache } from "./client";
import {
  getGitCommits,
  getGitLocalCommits,
  gitAmendCommit,
  gitCommit,
} from "./commits";
import {
  getGitBatchFileDiffs,
  getGitCommitDiff,
  getGitDiffNumstat,
  getGitDiffNumstatCombined,
  getGitDiffSummary,
  getGitFileContent,
  getGitFileDiff,
  getGitStagedDiff,
  getGitStagedFileDiff,
} from "./diff";
import { gitMerge, gitMergeAbort, gitMergeContinue } from "./merge";
import { gitFetch, gitPull, gitPush } from "./operations";
import {
  gitRebase,
  gitRebaseAbort,
  gitRebaseContinue,
  gitRebaseSkip,
} from "./rebase";
import {
  addGitRemote,
  deleteGitRemote,
  fillGitCredentials,
  getGitRemotes,
  updateGitRemote,
} from "./remotes";
import { gitReset } from "./reset";
import { gitRevert, gitRevertAbort } from "./revert";
import {
  gitDiscardChanges,
  gitResolveConflict,
  gitStageFiles,
  gitUnstageFiles,
} from "./staging";
import {
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPush,
} from "./stash";
import { getGitStatus, getGitSuggestedAction } from "./status";
import { createGitWorktree, getGitWorktrees } from "./worktrees";

// Re-export all types
export * from "./types";

// Re-export status functions
export { getGitStatus } from "./status";

// Re-export worktree functions
export {
  createGitWorktree,
  getGitWorktrees,
  removeGitWorktree,
} from "./worktrees";

// Re-export branch functions
export {
  getGitBranches,
  getGitCurrentBranchName,
  getGitDefaultBranch,
} from "./branches";

// Re-export commit functions
export { getGitCommits, gitCommit, gitAmendCommit } from "./commits";

// Re-export remote functions
export { getGitRemotes, fillGitCredentials } from "./remotes";

// Re-export remote operations
export { gitFetch, gitPull, gitPush } from "./operations";

// Re-export stash functions
export {
  gitStashPush,
  gitStashList,
  gitStashApply,
  gitStashDrop,
} from "./stash";

// Re-export staging functions
export {
  gitStageFiles,
  gitUnstageFiles,
  gitDiscardChanges,
  gitResolveConflict,
} from "./staging";

// Re-export branch operations
export { gitCreateBranch, gitDeleteBranch, gitCheckout } from "./branchOps";

// Re-export merge functions
export { gitMergeAbort } from "./merge";

// Re-export rebase functions
export { gitRebaseAbort } from "./rebase";

// Re-export cherry-pick functions
export { gitCherryPick } from "./cherryPick";

// Re-export revert functions
export { gitRevert } from "./revert";

// Re-export reset function
export { gitReset } from "./reset";

// Re-export diff functions
export {
  getGitFileContent,
  getGitBatchFileDiffs,
  getGitDiffNumstatCombined,
  getGitDiffSummary,
  getGitCommitDiff,
} from "./diff";

// Re-export blame function
export { getGitBlame } from "./blame";

// Export all API functions as a single object
export const gitApi = {
  // Status & Info
  getGitStatus,
  getGitBranches,
  getGitCurrentBranch,
  getGitCurrentBranchName,
  getGitAheadBehind,
  getGitDefaultBranch,
  getGitCommits,
  getGitLocalCommits,
  getGitSuggestedAction,

  // Remotes
  getGitRemotes,
  addGitRemote,
  updateGitRemote,
  deleteGitRemote,
  fillGitCredentials,

  // Remote Operations
  gitFetch,
  gitPull,
  gitPush,

  // Commit
  gitCommit,
  gitAmendCommit,

  // Stash
  gitStashPush,
  gitStashList,
  gitStashApply,
  gitStashDrop,

  // Staging
  gitStageFiles,
  gitUnstageFiles,
  gitDiscardChanges,
  gitResolveConflict,

  // Branches
  gitCreateBranch,
  gitDeleteBranch,
  gitRenameBranch,
  gitCheckout,

  // Merge
  gitMerge,
  gitMergeAbort,
  gitMergeContinue,

  // Rebase
  gitRebase,
  gitRebaseAbort,
  gitRebaseContinue,
  gitRebaseSkip,

  // Cherry-pick
  gitCherryPick,
  gitCherryPickContinue,
  gitCherryPickAbort,

  // Revert
  gitRevert,
  gitRevertAbort,

  // Reset
  gitReset,

  // Diffs
  getGitFileContent,
  getGitFileDiff,
  getGitBatchFileDiffs,
  getGitDiffNumstat,
  getGitDiffNumstatCombined,
  getGitDiffSummary,
  getGitStagedDiff,
  getGitStagedFileDiff,
  getGitCommitDiff,

  // Blame
  getGitBlame,

  // Worktrees
  createGitWorktree,
  getGitWorktrees,

  // Cache management
  clearStatusCache,
};

export default gitApi;
