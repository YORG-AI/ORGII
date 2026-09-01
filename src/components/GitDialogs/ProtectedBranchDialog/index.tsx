/**
 * ProtectedBranchDialog
 *
 * Shown when git push fails because the target branch is protected.
 * Suggests creating a pull request instead.
 * Uses native Tauri system dialog.
 *
 * @example
 * ```tsx
 * import { ProtectedBranchDialog } from "@src/components/GitDialogs";
 *
 * const result = await ProtectedBranchDialog.open({
 *   branchName: "main",
 * });
 *
 * if (result === "create_pr") {
 *   // Open PR creation flow
 * }
 * ```
 */

// ============================================
// Types
// ============================================

type ProtectedBranchResult = "create_pr" | "cancel";

interface ProtectedBranchOptions {
  branchName?: string;
  remoteName?: string;
}

// ============================================
// Manager Class (Imperative API)
// ============================================

class ProtectedBranchDialogManager {
  /**
   * Open the protected branch dialog using native system dialog
   * @returns Promise that resolves with user's choice
   */
  public async open(
    options: ProtectedBranchOptions = {}
  ): Promise<ProtectedBranchResult> {
    const { message } = await import("@tauri-apps/plugin-dialog");

    const branchName = options.branchName || "main";
    const remoteName = options.remoteName || "origin";

    const result = await message(
      `The branch "${branchName}" on ${remoteName} is protected and cannot be pushed to directly.\n\nProtected branches require changes to go through pull requests.`,
      {
        title: "Protected Branch",
        kind: "warning",
        buttons: {
          ok: "Create Pull Request",
          cancel: "Cancel",
        },
      }
    );

    if (result === "Create Pull Request") {
      return "create_pr";
    } else {
      return "cancel";
    }
  }
}

// Create singleton instance
export const ProtectedBranchDialog = new ProtectedBranchDialogManager();

export default ProtectedBranchDialog;
