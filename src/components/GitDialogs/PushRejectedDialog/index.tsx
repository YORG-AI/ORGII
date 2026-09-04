/**
 * PushRejectedDialog
 *
 * Shown when git push fails because remote has commits
 * that local doesn't have (non-fast-forward error).
 * Uses native Tauri system dialog.
 *
 * @example
 * ```tsx
 * import { PushRejectedDialog } from "@src/components/GitDialogs";
 *
 * const result = await PushRejectedDialog.open({
 *   branchName: "main",
 *   behindCount: 3,
 * });
 *
 * if (result === "pull_push") {
 *   // Pull then push
 * } else if (result === "force") {
 *   // Force push
 * }
 * ```
 */

// ============================================
// Types
// ============================================

type PushRejectedResult = "pull_push" | "force" | "cancel";

interface PushRejectedOptions {
  branchName?: string;
  remoteName?: string;
  behindCount?: number;
}

// ============================================
// Manager Class (Imperative API)
// ============================================

class PushRejectedDialogManager {
  /**
   * Open the push rejected dialog using native system dialog
   * @returns Promise that resolves with user's choice
   */
  public async open(
    options: PushRejectedOptions = {}
  ): Promise<PushRejectedResult> {
    const { message } = await import("@tauri-apps/plugin-dialog");

    const branchName = options.branchName || "current branch";
    const remoteName = options.remoteName || "origin";
    const behindInfo =
      options.behindCount && options.behindCount > 0
        ? ` (${options.behindCount} commit${options.behindCount !== 1 ? "s" : ""} behind)`
        : "";

    const result = await message(
      `Can't push to ${remoteName}/${branchName}.\n\nThe remote branch contains commits that you don't have locally.${behindInfo}\n\n⚠️ Force push will overwrite remote changes permanently.`,
      {
        title: "Push Rejected",
        kind: "warning",
        buttons: {
          yes: "Pull & Push",
          no: "Force Push",
          cancel: "Cancel",
        },
      }
    );

    if (result === "Pull & Push") {
      return "pull_push";
    } else if (result === "Force Push") {
      return "force";
    } else {
      return "cancel";
    }
  }
}

// Create singleton instance
export const PushRejectedDialog = new PushRejectedDialogManager();

export default PushRejectedDialog;
