/**
 * RebaseConflictDialog
 *
 * Shown when git rebase encounters conflicts.
 * Offers options to resolve or abort the rebase.
 * Uses native Tauri system dialog.
 *
 * @example
 * ```tsx
 * import { RebaseConflictDialog } from "@src/components/GitDialogs";
 *
 * const result = await RebaseConflictDialog.open({
 *   targetBranch: "main",
 *   currentStep: 3,
 *   totalSteps: 5,
 *   conflictingFiles: ["src/index.ts"],
 * });
 *
 * if (result === "resolve") {
 *   // Open conflict resolution
 * } else if (result === "abort") {
 *   // Abort rebase
 * }
 * ```
 */

// ============================================
// Types
// ============================================

type RebaseConflictResult = "resolve" | "abort" | "cancel";

interface RebaseConflictOptions {
  targetBranch?: string;
  currentStep?: number;
  totalSteps?: number;
  conflictingFiles?: string[];
  /** Type of operation that caused the conflict */
  operationType?: "rebase" | "merge";
}

// ============================================
// Manager Class (Imperative API)
// ============================================

class RebaseConflictDialogManager {
  /**
   * Open the rebase conflict dialog using native system dialog
   * @returns Promise that resolves with user's choice
   */
  public async open(
    options: RebaseConflictOptions = {}
  ): Promise<RebaseConflictResult> {
    const { message } = await import("@tauri-apps/plugin-dialog");

    const targetBranch = options.targetBranch || "main";
    const operationType = options.operationType || "rebase";
    const isMerge = operationType === "merge";
    const hasProgress =
      options.currentStep !== undefined && options.totalSteps !== undefined;
    const progressInfo = hasProgress
      ? ` (Step ${options.currentStep} of ${options.totalSteps})`
      : "";
    const fileCount = options.conflictingFiles?.length || 0;
    const fileInfo =
      fileCount > 0
        ? `\n\n${fileCount} file${fileCount !== 1 ? "s" : ""} with conflicts.`
        : "";

    const title = isMerge ? "Merge Conflict" : "Rebase Conflict";
    const actionText = isMerge ? "merging" : "rebasing onto";
    const abortLabel = isMerge ? "Abort Merge" : "Abort Rebase";
    const warningText = isMerge
      ? "Aborting will cancel the merge and restore your branch."
      : "Aborting will restore your branch to its state before rebasing.";

    const result = await message(
      `Conflicts occurred while ${actionText} "${targetBranch}".${progressInfo}${fileInfo}\n\n⚠️ ${warningText}`,
      {
        title,
        kind: "error",
        buttons: {
          yes: "Resolve Conflicts",
          no: abortLabel,
          cancel: "Cancel",
        },
      }
    );

    if (result === "Resolve Conflicts") {
      return "resolve";
    } else if (result === abortLabel) {
      return "abort";
    } else {
      return "cancel";
    }
  }
}

// Create singleton instance
export const RebaseConflictDialog = new RebaseConflictDialogManager();

export default RebaseConflictDialog;
