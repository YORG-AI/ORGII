/**
 * Git Dialogs
 *
 * Collection of imperative dialogs for git operations.
 * All dialogs use native Tauri system dialogs for consistency.
 *
 * @example
 * ```tsx
 * import {
 *   PullConflictDialog,
 *   PushRejectedDialog,
 *   DetachedHeadDialog,
 *   ProtectedBranchDialog,
 *   LargePushConfirmDialog,
 *   RebaseConflictDialog,
 *   RemoteBranchDeletedDialog,
 * } from "@src/components/GitDialogs";
 *
 * // All dialogs use the same imperative API pattern:
 * const result = await PushRejectedDialog.open({
 *   branchName: "main",
 *   behindCount: 3,
 * });
 * ```
 */

// ============================================
// Dialog Exports
// ============================================

export { PullConflictDialog } from "./PullConflictDialog";

export { PushRejectedDialog } from "./PushRejectedDialog";

export { DetachedHeadDialog } from "./DetachedHeadDialog";

export { ProtectedBranchDialog } from "./ProtectedBranchDialog";

export {
  LargePushConfirmDialog,
  LARGE_PUSH_THRESHOLD,
} from "./LargePushConfirmDialog";

export { RebaseConflictDialog } from "./RebaseConflictDialog";

export {
  CheckoutConflictDialog,
  type CheckoutConflictResult,
} from "./CheckoutConflictDialog";

export { CheckoutBlockedDialog } from "./CheckoutBlockedDialog";
