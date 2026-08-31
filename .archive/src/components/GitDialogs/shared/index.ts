/**
 * Shared exports for Git Dialogs
 * All dialogs now use native Tauri system dialogs
 */

// Re-export types
export type {
  PullConflictResult,
  PullConflictOptions,
  PushRejectedResult,
  PushRejectedOptions,
  DetachedHeadResult,
  DetachedHeadOptions,
  ProtectedBranchResult,
  ProtectedBranchOptions,
  LargePushResult,
  LargePushOptions,
  RebaseConflictResult,
  RebaseConflictOptions,
  RemoteBranchDeletedResult,
  RemoteBranchDeletedOptions,
} from "./types";
