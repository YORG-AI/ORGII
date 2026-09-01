/**
 * CheckoutConflictDialog
 *
 * System dialog shown when git checkout fails due to uncommitted changes.
 * Uses native Tauri three-way dialog (Stash & Checkout / Discard & Checkout / Cancel).
 *
 * @example
 * ```tsx
 * import { CheckoutConflictDialog } from "@src/components/GitDialogs";
 *
 * const result = await CheckoutConflictDialog.open({
 *   branchName: "feature-branch",
 * });
 *
 * if (result === "stash") {
 *   // User chose to stash and checkout
 * } else if (result === "force") {
 *   // User chose force checkout (discard changes)
 * } else {
 *   // User cancelled
 * }
 * ```
 */

// ============================================
// Types
// ============================================

export type CheckoutConflictResult = "stash" | "force" | "cancel";

interface CheckoutConflictOptions {
  branchName: string;
}

// ============================================
// Manager Class (Imperative API)
// ============================================

class CheckoutConflictDialogManager {
  /**
   * Open the checkout conflict dialog using native system dialog
   * @returns Promise that resolves with user's choice
   */
  public async open(
    options: CheckoutConflictOptions
  ): Promise<CheckoutConflictResult> {
    const { message } = await import("@tauri-apps/plugin-dialog");

    const result = await message(
      `Local changes would be overwritten when checking out "${options.branchName}".`,
      {
        title: "Checkout Conflict",
        kind: "warning",
        buttons: {
          yes: "Stash & Checkout",
          no: "Discard & Checkout",
          cancel: "Cancel",
        },
      }
    );

    // Result is the button label
    if (result === "Stash & Checkout") {
      return "stash";
    } else if (result === "Discard & Checkout") {
      return "force";
    } else {
      return "cancel";
    }
  }
}

// Create singleton instance
export const CheckoutConflictDialog = new CheckoutConflictDialogManager();

export default CheckoutConflictDialog;
