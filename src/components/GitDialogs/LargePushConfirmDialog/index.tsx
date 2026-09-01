/**
 * LargePushConfirmDialog
 *
 * Shown when user is about to push a large number of commits.
 * Asks for confirmation to prevent accidental large pushes.
 * Uses native Tauri system dialog.
 *
 * @example
 * ```tsx
 * import { LargePushConfirmDialog } from "@src/components/GitDialogs";
 *
 * const result = await LargePushConfirmDialog.open({
 *   commitCount: 25,
 *   branchName: "feature/big-change",
 * });
 *
 * if (result === "push") {
 *   // Proceed with push
 * }
 * ```
 */

// ============================================
// Constants
// ============================================

/** Threshold for showing this dialog */
export const LARGE_PUSH_THRESHOLD = 10;

// ============================================
// Types
// ============================================

type LargePushResult = "push" | "cancel";

interface LargePushOptions {
  commitCount: number;
  branchName?: string;
  remoteName?: string;
}

// ============================================
// Manager Class (Imperative API)
// ============================================

class LargePushConfirmDialogManager {
  /**
   * Open the large push confirm dialog using native system dialog
   * @returns Promise that resolves with user's choice
   */
  public async open(options: LargePushOptions): Promise<LargePushResult> {
    const { message } = await import("@tauri-apps/plugin-dialog");

    const {
      commitCount,
      branchName = "current branch",
      remoteName = "origin",
    } = options;

    const result = await message(
      `You are about to push ${commitCount} commits to ${remoteName}/${branchName}.\n\nThis is more than usual. Are you sure you want to continue?\n\n💡 Consider breaking large changes into smaller, more focused commits.`,
      {
        title: "Large Push Detected",
        kind: "warning",
        buttons: {
          ok: "Push All Commits",
          cancel: "Cancel",
        },
      }
    );

    if (result === "Push All Commits") {
      return "push";
    } else {
      return "cancel";
    }
  }
}

// Create singleton instance
export const LargePushConfirmDialog = new LargePushConfirmDialogManager();

export default LargePushConfirmDialog;
