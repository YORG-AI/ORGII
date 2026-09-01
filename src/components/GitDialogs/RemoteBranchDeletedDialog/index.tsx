/**
 * RemoteBranchDeletedDialog
 *
 * Shown when fetch/pull discovers that the remote tracking branch
 * has been deleted but local branch still exists.
 * Uses native Tauri system dialog.
 *
 * @example
 * ```tsx
 * import { RemoteBranchDeletedDialog } from "@src/components/GitDialogs";
 *
 * const result = await RemoteBranchDeletedDialog.open({
 *   branchName: "feature/old-feature",
 *   suggestedBranches: ["main", "develop"],
 * });
 *
 * if (result === "switch") {
 *   // Switch to main branch
 * } else if (result === "delete_local") {
 *   // Delete the local branch
 * } else if (result === "keep") {
 *   // Keep working on local branch
 * }
 * ```
 */

// ============================================
// Types
// ============================================

type RemoteBranchDeletedResult = "switch" | "delete_local" | "keep" | "cancel";

interface RemoteBranchDeletedOptions {
  branchName?: string;
  remoteName?: string;
  suggestedBranches?: string[];
}

// ============================================
// Manager Class (Imperative API)
// ============================================

class RemoteBranchDeletedDialogManager {
  /**
   * Open the remote branch deleted dialog using native system dialog
   * @returns Promise that resolves with user's choice
   */
  public async open(
    options: RemoteBranchDeletedOptions = {}
  ): Promise<RemoteBranchDeletedResult> {
    const { message } = await import("@tauri-apps/plugin-dialog");

    const branchName = options.branchName || "current branch";
    const remoteName = options.remoteName || "origin";
    const suggestedBranch = options.suggestedBranches?.[0] || "main";

    const result = await message(
      `The remote tracking branch "${remoteName}/${branchName}" has been deleted, but your local branch still exists.\n\n⚠️ Deleting the local branch will discard any unpushed commits.`,
      {
        title: "Remote Branch Deleted",
        kind: "warning",
        buttons: {
          yes: `Switch to ${suggestedBranch}`,
          no: "Delete Local Branch",
          cancel: "Keep Local Branch",
        },
      }
    );

    if (result === `Switch to ${suggestedBranch}`) {
      return "switch";
    } else if (result === "Delete Local Branch") {
      return "delete_local";
    } else if (result === "Keep Local Branch") {
      return "keep";
    } else {
      return "cancel";
    }
  }
}

// Create singleton instance
export const RemoteBranchDeletedDialog = new RemoteBranchDeletedDialogManager();

export default RemoteBranchDeletedDialog;
