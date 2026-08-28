/**
 * Git Operation Handler Factory
 *
 * Creates standardized git operation handlers with consistent stream
 * lifecycle, error classification, and error-dialog handling.
 *
 * Streamed lines are accumulated in memory purely to populate the git error
 * dialog — the Output panel they used to be rendered into was archived
 * (see `.archive/README.md`).
 */
import type { GitErrorType } from "@src/api/http/git/streaming";
import { showGitErrorAndHandle } from "@src/hooks/git/useGitErrorDialog";
import type {
  GitOperationResult,
  GitOperationType,
  OperationContext,
} from "@src/types/workstation/gitOutputIntegration";

// ============================================
// Stream Callback Types
// ============================================

function inferGitErrorTypeFromText(
  operationName: GitOperationType,
  errorText: string
): GitErrorType {
  const normalizedText = errorText.toLowerCase();

  // Protected-branch first: git appends "failed to push some refs" to every
  // rejection, so the broader non-fast-forward family below would otherwise
  // shadow policy rejections and tell the user to pull, which cannot help.
  if (
    operationName === "push" &&
    (normalizedText.includes("protected branch") ||
      normalizedText.includes("branch is protected") ||
      normalizedText.includes("pre-receive hook declined") ||
      normalizedText.includes("remote rejected"))
  ) {
    return "protected_branch";
  }

  if (
    operationName === "push" &&
    (normalizedText.includes("non-fast-forward") ||
      normalizedText.includes("fetch first") ||
      normalizedText.includes("updates were rejected") ||
      normalizedText.includes("failed to push some refs"))
  ) {
    return "non_fast_forward";
  }

  if (
    operationName === "pull" &&
    (normalizedText.includes("would be overwritten") ||
      normalizedText.includes("your local changes") ||
      normalizedText.includes("uncommitted changes") ||
      normalizedText.includes("unstaged changes") ||
      normalizedText.includes("please commit or stash them") ||
      normalizedText.includes("please commit your changes or stash them"))
  ) {
    return "uncommitted_changes";
  }

  if (
    operationName === "pull" &&
    (normalizedText.includes("conflict") ||
      normalizedText.includes("automatic merge failed"))
  ) {
    return "merge_conflicts";
  }

  if (
    normalizedText.includes("authentication") ||
    normalizedText.includes("permission denied") ||
    normalizedText.includes("could not read username") ||
    normalizedText.includes("bad credentials")
  ) {
    return "authentication_failed";
  }

  return "unknown";
}

function resolveGitErrorType(
  operationName: GitOperationType,
  explicitErrorType: GitErrorType | undefined,
  errorText: string
): GitErrorType {
  if (explicitErrorType && explicitErrorType !== "unknown") {
    return explicitErrorType;
  }
  return inferGitErrorTypeFromText(operationName, errorText);
}

export interface StreamCallbacks {
  onOutput: (line: string) => void;
  onComplete: (success: boolean, errorType?: GitErrorType) => void;
  onError: (error: string, errorType?: GitErrorType) => void;
}

export type StreamFunction<TParams> = (
  params: TParams & { repo_id: string; repo_path: string },
  callbacks: StreamCallbacks
) => Promise<() => void>;

// ============================================
// Operation Config
// ============================================

export interface GitOperationConfig<TParams> {
  /** The streaming API function to call */
  streamFn: StreamFunction<TParams>;
  /** Operation name for logs and error dialogs */
  operationName: GitOperationType;
  /** Capitalize operation name for display */
  operationLabel: string;
}

// ============================================
// Factory Function
// ============================================

/**
 * Creates a git operation handler with consistent behavior.
 *
 * All git operations (push, pull, fetch, commit, stage) follow the same pattern:
 * 1. Cleanup previous stream
 * 2. Start streaming, accumulating output for the error dialog
 * 3. Show error dialog if needed
 * 4. Resolve promise
 */
export function createGitOperationHandler<TParams>(
  config: GitOperationConfig<TParams>
): (context: OperationContext, params: TParams) => Promise<GitOperationResult> {
  const { streamFn, operationName, operationLabel } = config;

  return (context, params) => {
    return new Promise((resolve) => {
      const { repoPath, repoId, cleanupRef } = context;
      const paramsWithDialogOption = params as TParams & {
        showErrorDialog?: boolean;
      };
      const showErrorDialog = paramsWithDialogOption.showErrorDialog !== false;
      delete paramsWithDialogOption.showErrorDialog;

      // Cleanup previous stream
      if (cleanupRef.current) {
        cleanupRef.current();
      }

      // Accumulate output for error dialog
      const outputLines: string[] = [];

      // Start streaming
      streamFn(
        {
          repo_id: repoId,
          repo_path: repoPath,
          ...params,
        },
        {
          onOutput: (line) => {
            outputLines.push(line);
          },
          onComplete: (success, errorType) => {
            cleanupRef.current = null;

            // Defer native dialog to next tick — showing NSAlert from within
            // a WebKit event callback can deadlock the main-thread render mutex
            const captured = outputLines.join("\n");
            const resolvedErrorType = success
              ? "none"
              : resolveGitErrorType(
                  operationName,
                  errorType,
                  `${operationLabel} operation failed\n${captured}`
                );
            if (
              showErrorDialog &&
              !success &&
              resolvedErrorType !== "none" &&
              resolvedErrorType !== "authentication_failed"
            ) {
              setTimeout(() => {
                showGitErrorAndHandle({
                  operation: operationName,
                  repoId,
                  repoPath,
                  errorType: resolvedErrorType,
                  errorMessage: `${operationLabel} operation failed`,
                  commandOutput: captured,
                });
              }, 0);
            }

            resolve({ success, errorType: resolvedErrorType });
          },
          onError: (error, errorType) => {
            cleanupRef.current = null;

            const captured = outputLines.join("\n");
            const resolvedErrorType = resolveGitErrorType(
              operationName,
              errorType,
              `${error}\n${captured}`
            );
            // Same auth guard as onComplete: the caller's credential-retry
            // flow opens its own dialog for auth failures, and showing both
            // stacked two modals.
            if (
              showErrorDialog &&
              resolvedErrorType !== "authentication_failed"
            ) {
              setTimeout(() => {
                showGitErrorAndHandle({
                  operation: operationName,
                  repoId,
                  repoPath,
                  errorType: resolvedErrorType,
                  errorMessage: error,
                  commandOutput: captured,
                });
              }, 0);
            }

            resolve({ success: false, errorType: resolvedErrorType });
          },
        }
      ).then(
        (cleanup) => {
          cleanupRef.current = cleanup;
        },
        (error: unknown) => {
          // Stream setup itself failed (backend down, bad URL): neither
          // callback will ever fire, so settle the promise here — without
          // this the operation's spinner never resolves.
          const message =
            error instanceof Error ? error.message : String(error);
          const resolvedErrorType = resolveGitErrorType(
            operationName,
            undefined,
            message
          );
          if (
            showErrorDialog &&
            resolvedErrorType !== "authentication_failed"
          ) {
            setTimeout(() => {
              showGitErrorAndHandle({
                operation: operationName,
                repoId,
                repoPath,
                errorType: resolvedErrorType,
                errorMessage: message,
              });
            }, 0);
          }
          resolve({ success: false, errorType: resolvedErrorType });
        }
      );
    });
  };
}

// ============================================
// Promise-based Operation Factory
// ============================================

/**
 * Creates a git operation handler that uses Promise reject for errors.
 * Used for commit and stage operations that need different error handling.
 */
export function createGitOperationHandlerWithReject<TParams>(
  config: GitOperationConfig<TParams>
): (context: OperationContext, params: TParams) => Promise<() => void> {
  const { streamFn, operationName, operationLabel } = config;

  return (context, params) => {
    return new Promise((resolve, reject) => {
      const { repoPath, repoId, cleanupRef } = context;

      // Cleanup previous stream
      if (cleanupRef.current) {
        cleanupRef.current();
      }

      // Accumulate output for error dialog
      const outputLines: string[] = [];

      // Start streaming
      streamFn(
        {
          repo_id: repoId,
          repo_path: repoPath,
          ...params,
        },
        {
          onOutput: (line) => {
            outputLines.push(line);
          },
          onComplete: (success) => {
            cleanupRef.current = null;

            if (success) {
              resolve(() => {});
            } else {
              const captured = outputLines.join("\n");
              setTimeout(() => {
                showGitErrorAndHandle({
                  operation: operationName,
                  repoId,
                  repoPath,
                  errorType: "unknown",
                  errorMessage: `${operationLabel} operation failed`,
                  commandOutput: captured,
                });
              }, 0);
              reject(new Error(`${operationLabel} operation failed`));
            }
          },
          onError: (error) => {
            cleanupRef.current = null;

            const captured = outputLines.join("\n");
            setTimeout(() => {
              showGitErrorAndHandle({
                operation: operationName,
                repoId,
                repoPath,
                errorType: "unknown",
                errorMessage: error,
                commandOutput: captured,
              });
            }, 0);

            reject(new Error(error));
          },
        }
      ).then(
        (cleanup) => {
          cleanupRef.current = cleanup;
        },
        (error: unknown) => {
          // Settle on stream-setup failure — see createGitOperationHandler.
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  };
}
