/**
 * Guarded checkout core (Issue #17 de-dup).
 *
 * The single source of truth for "checkout a ref, and when the working tree is
 * dirty surface the stash/discard/cancel conflict flow". Extracted out of
 * `useBranchCheckout` (a React hook) into a plain async function so BOTH the
 * canonical hook path (`useBranchCheckout.selectBranch`) and the ActionSystem
 * service path (`branchOps.checkoutWithDialog`) can share it without a service
 * importing hook state.
 *
 * The conflict dialog is injected via `onConflict` so the core stays UI-free and
 * testable; both call sites pass `CheckoutConflictDialog.open`.
 */
import { gitApi } from "@src/api/http/git";
import type {
  CheckoutErrorType,
  GitCheckoutResult,
} from "@src/api/http/git/branchOps";
import type { CheckoutConflictResult } from "@src/components/GitDialogs/CheckoutConflictDialog";

export type CheckoutBlockedErrorType = Exclude<
  CheckoutErrorType,
  "uncommitted_changes"
>;

/**
 * How a guarded checkout resolved.
 * - `checked-out`: clean tree, direct checkout succeeded
 * - `stashed`: dirty tree → stashed local changes → checkout succeeded
 * - `forced`: dirty tree → discarded local changes (force) → checkout succeeded
 * - `cancelled`: dirty tree → user cancelled the conflict dialog (no checkout)
 * - `error`: checkout (or stash/force recovery) failed
 */
export type GuardedCheckoutOutcome =
  | "checked-out"
  | "stashed"
  | "forced"
  | "cancelled"
  | "error";

export interface GuardedCheckoutResult {
  /** True only when the ref is now checked out (checked-out / stashed / forced). */
  success: boolean;
  outcome: GuardedCheckoutOutcome;
  /** Original git-checkout error classification ("none" on success). */
  errorType: CheckoutErrorType | "none";
  /**
   * Human-readable message. On success outcomes this is an info string suitable
   * for a toast; otherwise it's the failure reason.
   */
  message?: string;
  /** True when `onBlocked` already surfaced this failure to the user. */
  blocked?: boolean;
}

export interface GuardedCheckoutParams {
  repoId: string;
  repoPath?: string;
  ref: string;
  /** Create the branch as part of the checkout. */
  create?: boolean;
  /**
   * Resolve the user's choice when the checkout fails because of uncommitted
   * changes. Injected so the core never imports a dialog directly.
   */
  onConflict: (branch: string) => Promise<CheckoutConflictResult>;
  onBlocked?: (options: {
    branch: string;
    errorType: CheckoutBlockedErrorType | "none";
    message?: string;
  }) => Promise<void>;
}

function failure(
  errorType: CheckoutErrorType | "none",
  message: string
): GuardedCheckoutResult {
  return { success: false, outcome: "error", errorType, message };
}

async function blockedFailure(options: {
  ref: string;
  errorType: CheckoutErrorType | "none";
  message: string;
  onBlocked?: GuardedCheckoutParams["onBlocked"];
}): Promise<GuardedCheckoutResult> {
  const { ref, errorType, message, onBlocked } = options;
  if (!onBlocked) return failure(errorType, message);
  await onBlocked({
    branch: ref,
    errorType: errorType === "uncommitted_changes" ? "other" : errorType,
    message,
  });
  return { ...failure(errorType, message), blocked: true };
}

async function stashAndCheckout(
  repoId: string,
  repoPath: string | undefined,
  ref: string,
  onBlocked?: GuardedCheckoutParams["onBlocked"]
): Promise<GuardedCheckoutResult> {
  try {
    const stashResult = await gitApi.gitStashPush({
      repo_id: repoId,
      repo_path: repoPath,
      message: `Auto-stash before switching to ${ref}`,
      include_untracked: true,
    });

    // gitStashPush never returns undefined on error — its wrapper catches and
    // returns { success: false, message } — so the success flag is the only
    // real failure signal. Proceeding past a failed stash would attempt the
    // checkout on a still-dirty tree and report a misleading generic error.
    if (!stashResult?.success) {
      return failure(
        "uncommitted_changes",
        stashResult?.message || "Failed to stash changes"
      );
    }

    const checkoutResult = await gitApi.gitCheckout({
      repo_id: repoId,
      repo_path: repoPath,
      ref,
    });

    if (checkoutResult.success) {
      return {
        success: true,
        outcome: "stashed",
        errorType: "none",
        message: `Switched to ${ref}. Changes stashed.`,
      };
    }

    return blockedFailure({
      ref,
      errorType: checkoutResult.errorType ?? "other",
      message: checkoutResult.error || "Failed to checkout after stash",
      onBlocked,
    });
  } catch {
    return failure("other", "Failed to stash and checkout");
  }
}

async function forceCheckout(
  repoId: string,
  repoPath: string | undefined,
  ref: string,
  onBlocked?: GuardedCheckoutParams["onBlocked"]
): Promise<GuardedCheckoutResult> {
  try {
    const forceResult = await gitApi.gitCheckout({
      repo_id: repoId,
      repo_path: repoPath,
      ref,
      force: true,
    });

    if (forceResult.success) {
      return {
        success: true,
        outcome: "forced",
        errorType: "none",
        message: `Switched to ${ref}`,
      };
    }

    return blockedFailure({
      ref,
      errorType: forceResult.errorType ?? "other",
      message: forceResult.error || "Failed to force checkout",
      onBlocked,
    });
  } catch {
    return failure("other", "Failed to force checkout");
  }
}

/**
 * Checkout `ref`, surfacing the conflict dialog (stash/discard/cancel) when the
 * working tree is dirty. Never throws — always resolves a normalized result.
 */
export async function runGuardedCheckout(
  params: GuardedCheckoutParams
): Promise<GuardedCheckoutResult> {
  const { repoId, repoPath, ref, create, onConflict, onBlocked } = params;

  let result: GitCheckoutResult;
  try {
    result = await gitApi.gitCheckout({
      repo_id: repoId,
      repo_path: repoPath,
      ref,
      create,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : `Failed to checkout branch "${ref}"`;
    return blockedFailure({
      ref,
      errorType: "other",
      message,
      onBlocked,
    });
  }

  if (result.success) {
    return { success: true, outcome: "checked-out", errorType: "none" };
  }

  if (result.errorType !== "uncommitted_changes") {
    return blockedFailure({
      ref,
      errorType: result.errorType ?? "other",
      message: result.error || `Failed to checkout branch "${ref}"`,
      onBlocked,
    });
  }

  const choice = await onConflict(ref);

  if (choice === "stash") {
    return stashAndCheckout(repoId, repoPath, ref, onBlocked);
  }
  if (choice === "force") {
    return forceCheckout(repoId, repoPath, ref, onBlocked);
  }

  return {
    success: false,
    outcome: "cancelled",
    errorType: "uncommitted_changes",
    message: `Checkout of "${ref}" cancelled. Local changes were kept.`,
  };
}
