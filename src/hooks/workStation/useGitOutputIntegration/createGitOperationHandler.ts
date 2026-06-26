/**
 * Git Operation Handler Factory
 *
 * Creates standardized git operation handlers with consistent
 * output streaming, error handling, and channel management.
 * This eliminates ~400 lines of duplicated code across operations.
 */
import type { GitErrorType } from "@src/api/http/git/streaming";
import { showGitErrorAndHandle } from "@src/hooks/git/useGitErrorDialog";

import {
  formatCommandMessage,
  formatErrorDetail,
  formatErrorMessage,
  formatSuccessMessage,
  formatTimestamp,
} from "./formatters";
import type {
  GitOperationResult,
  GitOperationType,
  OperationContext,
} from "./types";

// ============================================
// Stream Callback Types
// ============================================

function inferGitErrorTypeFromText(
  operationName: GitOperationType,
  errorText: string
): GitErrorType {
  const normalizedText = errorText.toLowerCase();

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
  /** Format the git command string for display */
  formatCommand: (params: TParams) => string;
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
 * 1. Get/create git channel
 * 2. Log command to output
 * 3. Set channel active
 * 4. Auto-switch to output panel
 * 5. Cleanup previous stream
 * 6. Start streaming with callbacks
 * 7. Log completion/error
 * 8. Show error dialog if needed
 * 9. Resolve promise
 *
 * SSE output lines are batched via requestAnimationFrame to prevent rapid
 * re-renders that can trigger a WebKit rendering mutex self-deadlock (Tauri/macOS).
 */
export function createGitOperationHandler<TParams>(
  config: GitOperationConfig<TParams>
): (context: OperationContext, params: TParams) => Promise<GitOperationResult> {
  const { streamFn, formatCommand, operationName, operationLabel } = config;

  return (context, params) => {
    return new Promise((resolve) => {
      const {
        outputState,
        repoPath,
        repoId,
        autoSwitchToOutput,
        onSwitchToOutput,
        getGitChannel,
        cleanupRef,
      } = context;
      const paramsWithDialogOption = params as TParams & {
        showErrorDialog?: boolean;
      };
      const showErrorDialog = paramsWithDialogOption.showErrorDialog !== false;
      delete paramsWithDialogOption.showErrorDialog;

      const channel = getGitChannel();
      const command = formatCommand(params);
      const startTime = Date.now();
      const timestamp = formatTimestamp();

      // Log command
      outputState.appendToChannel(
        channel.id,
        formatCommandMessage(timestamp, command)
      );
      outputState.setActiveChannel(channel.id);
      outputState.setChannelActive(channel.id, true);

      // Auto-switch to Output panel
      if (autoSwitchToOutput && onSwitchToOutput) {
        onSwitchToOutput();
      }

      // Cleanup previous stream
      if (cleanupRef.current) {
        cleanupRef.current();
      }

      // Accumulate output for error dialog
      const outputLines: string[] = [];

      // Batch SSE output to coalesce rapid lines into fewer DOM updates
      const pendingLines: string[] = [];
      let flushFrameId: number | null = null;

      const flushPendingOutput = () => {
        flushFrameId = null;
        if (pendingLines.length > 0) {
          const batch = pendingLines.join("");
          pendingLines.length = 0;
          outputState.appendToChannel(channel.id, batch);
        }
      };

      const flushPendingOutputSync = () => {
        if (flushFrameId !== null) {
          cancelAnimationFrame(flushFrameId);
          flushFrameId = null;
        }
        flushPendingOutput();
      };

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
            pendingLines.push(`${line}\n`);
            if (flushFrameId === null) {
              flushFrameId = requestAnimationFrame(flushPendingOutput);
            }
          },
          onComplete: (success, errorType) => {
            flushPendingOutputSync();
            outputState.setChannelActive(channel.id, false);
            const duration = Date.now() - startTime;
            const endTimestamp = formatTimestamp();

            const message = success
              ? formatSuccessMessage(endTimestamp, operationLabel, duration)
              : formatErrorMessage(endTimestamp, operationLabel, duration);

            outputState.appendToChannel(channel.id, message);
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
            flushPendingOutputSync();
            outputState.setChannelActive(channel.id, false);
            const endTimestamp = formatTimestamp();

            outputState.appendToChannel(
              channel.id,
              formatErrorDetail(endTimestamp, error)
            );
            cleanupRef.current = null;

            const captured = outputLines.join("\n");
            const resolvedErrorType = resolveGitErrorType(
              operationName,
              errorType,
              `${error}\n${captured}`
            );
            if (showErrorDialog) {
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
      ).then((cleanup) => {
        cleanupRef.current = cleanup;
      });
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
  config: GitOperationConfig<TParams> & {
    /** Custom success message formatter */
    formatSuccessMsg?: (params: TParams, durationMs: number) => string;
  }
): (context: OperationContext, params: TParams) => Promise<() => void> {
  const {
    streamFn,
    formatCommand,
    operationName,
    operationLabel,
    formatSuccessMsg,
  } = config;

  return (context, params) => {
    return new Promise((resolve, reject) => {
      const {
        outputState,
        repoPath,
        repoId,
        autoSwitchToOutput,
        onSwitchToOutput,
        getGitChannel,
        cleanupRef,
      } = context;

      const channel = getGitChannel();
      const command = formatCommand(params);
      const startTime = Date.now();
      const timestamp = formatTimestamp();

      // Log command
      outputState.appendToChannel(
        channel.id,
        formatCommandMessage(timestamp, command)
      );
      outputState.setActiveChannel(channel.id);
      outputState.setChannelActive(channel.id, true);

      // Auto-switch to Output panel
      if (autoSwitchToOutput && onSwitchToOutput) {
        onSwitchToOutput();
      }

      // Cleanup previous stream
      if (cleanupRef.current) {
        cleanupRef.current();
      }

      // Accumulate output for error dialog
      const outputLines: string[] = [];

      // Batch SSE output (same as createGitOperationHandler)
      const pendingLines: string[] = [];
      let flushFrameId: number | null = null;

      const flushPendingOutput = () => {
        flushFrameId = null;
        if (pendingLines.length > 0) {
          const batch = pendingLines.join("");
          pendingLines.length = 0;
          outputState.appendToChannel(channel.id, batch);
        }
      };

      const flushPendingOutputSync = () => {
        if (flushFrameId !== null) {
          cancelAnimationFrame(flushFrameId);
          flushFrameId = null;
        }
        flushPendingOutput();
      };

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
            pendingLines.push(`${line}\n`);
            if (flushFrameId === null) {
              flushFrameId = requestAnimationFrame(flushPendingOutput);
            }
          },
          onComplete: (success) => {
            flushPendingOutputSync();
            outputState.setChannelActive(channel.id, false);
            const duration = Date.now() - startTime;
            const endTimestamp = formatTimestamp();

            const message = success
              ? formatSuccessMsg
                ? formatSuccessMsg(params, duration)
                : formatSuccessMessage(endTimestamp, operationLabel, duration)
              : formatErrorMessage(endTimestamp, operationLabel, duration);

            outputState.appendToChannel(channel.id, message);
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
            flushPendingOutputSync();
            outputState.setChannelActive(channel.id, false);
            const endTimestamp = formatTimestamp();

            outputState.appendToChannel(
              channel.id,
              formatErrorDetail(endTimestamp, error)
            );
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
      ).then((cleanup) => {
        cleanupRef.current = cleanup;
      });
    });
  };
}
