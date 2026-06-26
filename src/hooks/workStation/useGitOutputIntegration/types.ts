/**
 * Git Output Integration Types
 *
 * Types and interfaces for the git output integration hook.
 */
import type { MutableRefObject } from "react";

import type { GitErrorType } from "@src/api/http/git/streaming";

import type { UseOutputChannelsReturn } from "../output/useOutputChannels";

// ============================================
// Result Types
// ============================================

/** Result of a git operation with success status and error type */
export interface GitOperationResult {
  success: boolean;
  errorType: GitErrorType;
}

// ============================================
// Options & Return Types
// ============================================

export interface UseGitOutputIntegrationOptions {
  /** Output panel state */
  outputState: UseOutputChannelsReturn;
  /** Repository path */
  repoPath: string;
  /** Repository ID */
  repoId: string;
  /** Auto-switch to Output panel when operation starts (default: true) */
  autoSwitchToOutput?: boolean;
  /** Callback to switch to Output panel */
  onSwitchToOutput?: () => void;
  /** Enable verbose logging (includes file watch events) - default: false */
  verbose?: boolean;
  /** Enable file watch heartbeat (shows "no changes" after 1 min idle) - default: true */
  enableWatchHeartbeat?: boolean;
}

export interface UseGitOutputIntegrationReturn {
  /** Push with output streaming - resolves with result including error type */
  pushWithOutput: (params: {
    remote?: string;
    branch?: string;
    set_upstream?: boolean;
    force?: boolean;
    showErrorDialog?: boolean;
  }) => Promise<GitOperationResult>;
  /** Pull with output streaming - resolves with result including error type */
  pullWithOutput: (params: {
    remote?: string;
    branch?: string;
    strategy?: string;
    showErrorDialog?: boolean;
  }) => Promise<GitOperationResult>;
  /** Fetch with output streaming - resolves with result including error type */
  fetchWithOutput: (params: {
    remote?: string;
    prune?: boolean;
    showErrorDialog?: boolean;
  }) => Promise<GitOperationResult>;
  /** Commit with output streaming - resolves with cleanup function when complete */
  commitWithOutput: (params: {
    message: string;
    coauthor?: boolean;
  }) => Promise<() => void>;
  /** Stage with output streaming - resolves with cleanup function when complete */
  stageWithOutput: (params: { files: string[] }) => Promise<() => void>;
  /** Log a file watch event (only if verbose mode enabled) */
  logFileWatchEvent: (
    eventType: "start" | "change" | "end",
    details?: string
  ) => void;
  /** Start file watch heartbeat (shows idle status after 1 min) */
  startWatchHeartbeat: () => void;
  /** Stop file watch heartbeat */
  stopWatchHeartbeat: () => void;
  /** Reset heartbeat timer (call when changes detected) */
  resetHeartbeat: () => void;
  /** Get Git channel ID */
  getGitChannelId: () => string | undefined;
}

// ============================================
// Internal Types
// ============================================

/** Output channel from UseOutputChannelsReturn */
export interface OutputChannel {
  id: string;
  name: string;
  type: string;
  content: string;
  active?: boolean;
  processAnsi?: boolean;
}

/** Context passed to operation handlers */
export interface OperationContext {
  outputState: UseOutputChannelsReturn;
  repoPath: string;
  repoId: string;
  autoSwitchToOutput: boolean;
  onSwitchToOutput?: () => void;
  getGitChannel: () => OutputChannel;
  formatTimestamp: () => string;
  cleanupRef: MutableRefObject<(() => void) | null>;
}

/** Git operation type for error dialogs */
export type GitOperationType =
  | "push"
  | "pull"
  | "fetch"
  | "commit"
  | "stage"
  | "checkout"
  | "merge"
  | "rebase";
