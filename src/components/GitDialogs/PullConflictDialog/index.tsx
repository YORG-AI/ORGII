/**
 * PullConflictDialog
 *
 * Shown when git pull fails because local has uncommitted changes
 * that would be overwritten by incoming changes.
 * Uses native Tauri system dialog.
 *
 * @example
 * ```tsx
 * import { PullConflictDialog } from "@src/components/GitDialogs";
 *
 * const result = await PullConflictDialog.open({
 *   branchName: "main",
 *   conflictingFiles: ["src/index.ts"],
 * });
 *
 * if (result === "stash_pull") {
 *   // Stash changes then pull
 * } else if (result === "discard_pull") {
 *   // Discard changes and pull
 * }
 * ```
 */

// ============================================
// Types
// ============================================

type PullConflictResult = "stash_pull" | "discard_pull" | "cancel";

interface PullConflictOptions {
  branchName?: string;
  remoteName?: string;
  conflictingFiles?: string[];
}

// ============================================
// Manager Class (Imperative API)
// ============================================

class PullConflictDialogManager {
  /**
   * Open the pull conflict dialog using native system dialog
   * @returns Promise that resolves with user's choice
   */
  public async open(
    options: PullConflictOptions = {}
  ): Promise<PullConflictResult> {
    const { message } = await import("@tauri-apps/plugin-dialog");

    const branchName = options.branchName || "current branch";
    const fileCount = options.conflictingFiles?.length || 0;
    const fileInfo =
      fileCount > 0
        ? ` (${fileCount} file${fileCount !== 1 ? "s" : ""} affected)`
        : "";

    const result = await message(
      `Your local changes would be overwritten by the incoming changes from "${branchName}".${fileInfo}\n\nChoose how to proceed:`,
      {
        title: "Can't Pull with Local Changes",
        kind: "warning",
        buttons: {
          yes: "Stash & Pull",
          no: "Discard & Pull",
          cancel: "Cancel",
        },
      }
    );

    if (result === "Stash & Pull") {
      return "stash_pull";
    } else if (result === "Discard & Pull") {
      return "discard_pull";
    } else {
      return "cancel";
    }
  }
}

// Create singleton instance
export const PullConflictDialog = new PullConflictDialogManager();

export default PullConflictDialog;
