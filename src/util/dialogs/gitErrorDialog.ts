/**
 * Git Error Dialog Utility
 *
 * Shows a native Tauri dialog when git operations fail.
 * Provides three options:
 * - Stash and Continue: Stashes local changes and retries the operation
 * - Open Git Log: Opens a new tab with CodeMirror to view error details
 * - Cancel: Dismisses the dialog
 */
import type { GitErrorType } from "@src/api/http/git/streaming";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("GitErrorDialog");

// ============================================
// Types
// ============================================

export type GitErrorDialogResult =
  | "open-git-log"
  | "stash-and-continue"
  | "show-output"
  | "cancel";

export interface GitErrorDialogOptions {
  /** The git operation that failed (push, pull, fetch, etc.) */
  operation: string;
  /** Optional repository ID for follow-up recovery actions */
  repoId?: string;
  /** Optional repository path for follow-up recovery actions */
  repoPath?: string;
  /** The type of error */
  errorType: GitErrorType;
  /** The error message from git */
  errorMessage: string;
  /** The full command output (if available) */
  commandOutput?: string;
  /** Timestamp of when the error occurred */
  timestamp?: Date;
}

export interface GitErrorInfo {
  /** The git operation that failed */
  operation: string;
  /** The type of error */
  errorType: GitErrorType;
  /** The error message */
  errorMessage: string;
  /** The full command output */
  commandOutput: string;
  /** Timestamp when error occurred */
  timestamp: Date;
}

// ============================================
// Error Message Configuration
// ============================================

const ERROR_TITLES: Record<GitErrorType, string> = {
  none: "Git: Operation Completed",
  non_fast_forward: "Git: Push Rejected",
  protected_branch: "Git: Protected Branch",
  authentication_failed: "Git: Authentication Failed",
  remote_branch_deleted: "Git: Remote Branch Deleted",
  uncommitted_changes: "Git: Uncommitted Changes",
  network_error: "Git: Network Error",
  merge_conflicts: "Git: Merge Conflicts",
  permission_denied: "Git: Permission Denied",
  unknown: "Git: Operation Failed",
};

const ERROR_MESSAGES: Record<GitErrorType, string> = {
  none: "The git operation completed successfully.",
  non_fast_forward:
    "Your push was rejected because the remote branch contains newer commits.",
  protected_branch:
    "The target branch is protected and cannot be updated by this operation.",
  authentication_failed:
    "Failed to authenticate with the remote repo. Check your credentials and try again.",
  remote_branch_deleted:
    "The remote branch appears to be deleted or no longer available.",
  uncommitted_changes:
    "Your local changes would be overwritten. Commit or stash them before retrying.",
  network_error:
    "Could not connect to the remote repo. Check your internet connection.",
  merge_conflicts:
    "The operation resulted in merge conflicts that need to be resolved.",
  permission_denied:
    "Permission was denied for this repository operation. Check your repository access.",
  unknown: "The git operation failed unexpectedly. See the log for details.",
};

const AUTH_ERROR_PATTERNS = [
  "authentication failed",
  "invalid credentials",
  "could not read username",
  "permission denied (publickey)",
] as const;

const NETWORK_ERROR_PATTERNS = [
  "could not resolve host",
  "connection refused",
  "network is unreachable",
  "unable to access",
  "connection timed out",
  "timeout",
] as const;

const PERMISSION_ERROR_PATTERNS = [
  "permission denied",
  "operation not permitted",
  "access denied",
  "not authorized",
] as const;

const PUSH_REJECTED_PATTERNS = [
  "non-fast-forward",
  "fetch first",
  "updates were rejected",
  "failed to push some refs",
] as const;

const PROTECTED_BRANCH_PATTERNS = [
  "protected branch",
  "branch is protected",
  "cannot push to",
  "pre-receive hook declined",
  "remote rejected",
] as const;

const UNCOMMITTED_CHANGES_PATTERNS = [
  "would be overwritten",
  "your local changes",
  "uncommitted changes",
  "unstaged changes",
  "please commit or stash them",
  "please commit your changes or stash them",
] as const;

const MERGE_CONFLICT_PATTERNS = ["conflict", "automatic merge failed"] as const;

const REMOTE_DELETED_PATTERNS = [
  "[deleted]",
  "remote ref does not exist",
] as const;

const ERROR_DETAIL_MARKERS = [
  "fatal:",
  "error:",
  "conflict",
  "permission denied",
  "rejected",
  "failed",
  "unable to",
  "could not",
] as const;

function includesAnyPattern(
  source: string,
  patterns: readonly string[]
): boolean {
  return patterns.some((pattern) => source.includes(pattern));
}

function inferErrorTypeFromText(
  operation: string,
  errorMessage: string,
  commandOutput?: string
): GitErrorType {
  const normalizedOperation = operation.toLowerCase();
  const combinedText = `${errorMessage}\n${commandOutput ?? ""}`.toLowerCase();

  if (
    (normalizedOperation === "push" || normalizedOperation === "sync") &&
    includesAnyPattern(combinedText, PUSH_REJECTED_PATTERNS)
  ) {
    return "non_fast_forward";
  }

  if (
    (normalizedOperation === "push" || normalizedOperation === "sync") &&
    includesAnyPattern(combinedText, PROTECTED_BRANCH_PATTERNS)
  ) {
    return "protected_branch";
  }

  if (
    (normalizedOperation === "pull" ||
      normalizedOperation === "sync" ||
      normalizedOperation === "checkout") &&
    includesAnyPattern(combinedText, UNCOMMITTED_CHANGES_PATTERNS)
  ) {
    return "uncommitted_changes";
  }

  if (
    (normalizedOperation === "pull" || normalizedOperation === "sync") &&
    includesAnyPattern(combinedText, MERGE_CONFLICT_PATTERNS)
  ) {
    return "merge_conflicts";
  }

  if (
    (normalizedOperation === "fetch" || normalizedOperation === "sync") &&
    includesAnyPattern(combinedText, REMOTE_DELETED_PATTERNS)
  ) {
    return "remote_branch_deleted";
  }

  if (includesAnyPattern(combinedText, AUTH_ERROR_PATTERNS)) {
    return "authentication_failed";
  }

  if (includesAnyPattern(combinedText, PERMISSION_ERROR_PATTERNS)) {
    return "permission_denied";
  }

  if (includesAnyPattern(combinedText, NETWORK_ERROR_PATTERNS)) {
    return "network_error";
  }

  return "unknown";
}

function isGenericOperationFailureMessage(
  message: string,
  operation: string
): boolean {
  const normalizedMessage = message.trim().toLowerCase();
  const normalizedOperation = operation.toLowerCase();

  return (
    normalizedMessage === `${normalizedOperation} failed` ||
    normalizedMessage === `${normalizedOperation} operation failed` ||
    normalizedMessage === "operation failed" ||
    normalizedMessage === "git operation failed" ||
    normalizedMessage ===
      "the git operation failed unexpectedly. see the log for details."
  );
}

function extractPrimaryErrorDetail(
  operation: string,
  errorMessage: string,
  commandOutput?: string
): string {
  const outputLines = (commandOutput ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const prioritizedOutput = outputLines.filter((line) =>
    includesAnyPattern(line.toLowerCase(), ERROR_DETAIL_MARKERS)
  );

  const outputDetail = prioritizedOutput.at(-1) ?? outputLines.at(-1);
  if (outputDetail) {
    return outputDetail;
  }

  if (!isGenericOperationFailureMessage(errorMessage, operation)) {
    return errorMessage;
  }

  return `${operation.charAt(0).toUpperCase() + operation.slice(1)} operation failed`;
}

// ============================================
// Dialog Function
// ============================================

/**
 * Show a git error dialog with three options
 *
 * Uses Tauri's message() with buttons object for true three-button support.
 * Returns the button label that was clicked.
 *
 * @param options - Error details and context
 * @returns Promise resolving to the user's choice
 */
export async function showGitErrorDialog(
  options: GitErrorDialogOptions
): Promise<GitErrorDialogResult> {
  const { operation, errorType, errorMessage, commandOutput } = options;

  const effectiveErrorType =
    errorType === "unknown"
      ? inferErrorTypeFromText(operation, errorMessage, commandOutput)
      : errorType;

  // Get title and base message for this error type
  const title = ERROR_TITLES[effectiveErrorType] || ERROR_TITLES.unknown;
  const baseMessage =
    ERROR_MESSAGES[effectiveErrorType] || ERROR_MESSAGES.unknown;

  // Build the dialog message
  const operationText = operation.charAt(0).toUpperCase() + operation.slice(1);
  const detailMessage = extractPrimaryErrorDetail(
    operation,
    errorMessage,
    commandOutput
  );
  const dialogMessage = `${operationText} failed: ${baseMessage}\n\n${detailMessage}`;
  const useUncommittedChangesFlow =
    effectiveErrorType === "uncommitted_changes";
  const unstashHint = useUncommittedChangesFlow
    ? `\n\nHint: "Stash and Continue" will stash your local changes (including untracked files), retry the operation, then ask if you want to restore those stashed changes.`
    : "";
  const finalDialogMessage = `${dialogMessage}${unstashHint}`;

  try {
    // Import Tauri dialog dynamically
    const { message } = await import("@tauri-apps/plugin-dialog");

    // Show native dialog with three buttons
    // Using buttons object: { yes, no, cancel } for three-button dialog
    // Result is the button LABEL that was clicked
    const result = await message(finalDialogMessage, {
      title,
      kind: "error",
      buttons: useUncommittedChangesFlow
        ? {
            yes: "Stash and Continue",
            no: "Open Git Log",
            cancel: "Cancel",
          }
        : {
            yes: "Open Git Log",
            no: "Show Command Output",
            cancel: "Cancel",
          },
    });

    // Result is the button label string
    if (result === "Stash and Continue") {
      return "stash-and-continue";
    }
    if (result === "Open Git Log") {
      return "open-git-log";
    }
    if (result === "Show Command Output") {
      return "show-output";
    }
    return "cancel";
  } catch (error) {
    log.error("[GitErrorDialog] Failed to show dialog:", error);
    return "cancel";
  }
}

/**
 * Build error info object for storage/logging
 */
export function buildGitErrorInfo(
  options: GitErrorDialogOptions
): GitErrorInfo {
  const effectiveErrorType =
    options.errorType === "unknown"
      ? inferErrorTypeFromText(
          options.operation,
          options.errorMessage,
          options.commandOutput
        )
      : options.errorType;

  return {
    operation: options.operation,
    errorType: effectiveErrorType,
    errorMessage: options.errorMessage,
    commandOutput: options.commandOutput || options.errorMessage,
    timestamp: options.timestamp || new Date(),
  };
}

export default showGitErrorDialog;
