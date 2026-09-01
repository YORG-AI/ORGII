/**
 * DetachedHeadDialog
 *
 * Shown when user tries to commit while in detached HEAD state.
 * Warns that commits may be lost and offers to create a branch.
 * Uses native Tauri system dialog.
 *
 * @example
 * ```tsx
 * import { DetachedHeadDialog } from "@src/components/GitDialogs";
 *
 * const result = await DetachedHeadDialog.open({
 *   commitHash: "abc1234",
 * });
 *
 * if (result === "create_branch") {
 *   // Create a new branch (prompt for name separately)
 * } else if (result === "continue") {
 *   // Continue with detached HEAD
 * }
 * ```
 */

// ============================================
// Types
// ============================================

type DetachedHeadResult = "create_branch" | "continue" | "cancel";

interface DetachedHeadOptions {
  commitHash?: string;
  suggestedBranchName?: string;
}

// ============================================
// Manager Class (Imperative API)
// ============================================

class DetachedHeadDialogManager {
  /**
   * Open the detached HEAD dialog using native system dialog
   * @returns Promise that resolves with user's choice
   */
  public async open(
    options: DetachedHeadOptions = {}
  ): Promise<DetachedHeadResult> {
    const { message } = await import("@tauri-apps/plugin-dialog");

    const commitHash = options.commitHash || "HEAD";
    const shortHash = commitHash.slice(0, 7);

    const result = await message(
      `You are in detached HEAD state at commit ${shortHash}.\n\nYou are not on any branch. Any commits you make may be lost if you checkout another branch without creating a new branch first.\n\n⚠️ Commits in detached HEAD state may be garbage collected.`,
      {
        title: "Detached HEAD State",
        kind: "warning",
        buttons: {
          yes: "Create Branch",
          no: "Continue Without Branch",
          cancel: "Cancel",
        },
      }
    );

    if (result === "Create Branch") {
      return "create_branch";
    } else if (result === "Continue Without Branch") {
      return "continue";
    } else {
      return "cancel";
    }
  }
}

// Create singleton instance
export const DetachedHeadDialog = new DetachedHeadDialogManager();

export default DetachedHeadDialog;
