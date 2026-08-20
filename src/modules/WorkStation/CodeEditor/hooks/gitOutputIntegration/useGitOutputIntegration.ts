/**
 * Git Output Integration Hook
 *
 * Integrates git operations with the Output panel's Git channel.
 * Automatically creates git channel, streams output, and manages channel state.
 * Subscribes to gitOperationAtom to log backend-detected operations.
 *
 * This is the main orchestrator hook that combines:
 * - Git remote operations (push, pull, fetch)
 * - Git staging operations (commit, stage)
 * - File watch heartbeat
 * - Backend operation logging
 */
import { useAtomValue } from "jotai";
import React, { useCallback, useEffect, useRef } from "react";

import { gitOperationAtom } from "@src/store/git";
import type {
  OutputChannel,
  UseGitOutputIntegrationOptions,
  UseGitOutputIntegrationReturn,
} from "@src/types/workstation/gitOutputIntegration";

import { loggedOperationIds, pruneLoggedOperationIds } from "./constants";
import { ANSI, formatTimestampFromDate } from "./formatters";
import { useFileWatchHeartbeat } from "./useFileWatchHeartbeat";
import { useGitOperations } from "./useGitOperations";
import { useGitStagingOperations } from "./useGitStagingOperations";

// ============================================
// Main Hook
// ============================================

/**
 * Hook to integrate git operations with Output panel.
 *
 * Provides streaming output for all git operations:
 * - push, pull, fetch (remote operations)
 * - commit, stage (staging operations)
 * - file watch events and heartbeat
 */
export function useGitOutputIntegration(
  options: UseGitOutputIntegrationOptions
): UseGitOutputIntegrationReturn {
  const {
    outputState,
    repoPath,
    repoId,
    autoSwitchToOutput = true,
    onSwitchToOutput,
    verbose = false,
    enableWatchHeartbeat = true,
  } = options;

  // Subscribe to backend-detected git operations
  const gitOperation = useAtomValue(gitOperationAtom);

  // Track if channel has been created
  const channelCreatedRef = useRef(false);

  // ============================================
  // Channel Management
  // ============================================

  /**
   * Get or create the git output channel.
   */
  const getGitChannel = useCallback((): OutputChannel => {
    const existing = outputState.channels.find((ch) => ch.type === "git");
    if (existing) {
      return existing as unknown as OutputChannel;
    }
    const channelId = outputState.createChannel("Git", "git");
    return {
      id: channelId,
      name: "Git",
      type: "git",
      content: "",
      active: false,
      processAnsi: true,
    };
  }, [outputState]);

  /**
   * Get Git channel ID.
   */
  const getGitChannelId = useCallback(() => {
    const channel = outputState.channels.find((ch) => ch.type === "git");
    return channel?.id;
  }, [outputState]);

  // Create git channel on mount and set as active by default
  useEffect(() => {
    if (channelCreatedRef.current) return;

    const existingChannel = outputState.channels.find(
      (ch) => ch.type === "git"
    );
    if (!existingChannel) {
      const channelId = outputState.createChannel("Git", "git");
      outputState.setActiveChannel(channelId);
      channelCreatedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============================================
  // Backend Operation Logging
  // ============================================

  /**
   * Log backend-detected git operations to Output panel.
   * Uses global deduplication to prevent duplicate logs when multiple editor tabs are open.
   */
  useEffect(() => {
    if (!gitOperation) return;
    if (gitOperation.repoId !== repoId) return;

    // Global deduplication check
    if (loggedOperationIds.has(gitOperation.id)) return;

    // Mark as logged before appending to prevent race conditions
    loggedOperationIds.add(gitOperation.id);
    pruneLoggedOperationIds();

    const channel = outputState.channels.find((ch) => ch.type === "git");
    if (!channel) return;

    // Format message
    const date = new Date(gitOperation.timestamp);
    const timestamp = formatTimestampFromDate(date);
    const icon = gitOperation.success ? "✓" : "✗";
    const color = gitOperation.success ? ANSI.green : ANSI.red;

    // Add period after summary if needed
    const summaryWithPeriod =
      gitOperation.details && !/[.!?]$/.test(gitOperation.summary.trim())
        ? `${gitOperation.summary}.`
        : gitOperation.summary;
    const detailsPart = gitOperation.details
      ? ` ${ANSI.dim}${gitOperation.details}${ANSI.reset}`
      : "";

    const message = `${timestamp} ${color}[${gitOperation.operation}]${ANSI.reset} ${icon} ${summaryWithPeriod}${detailsPart}\n`;

    outputState.appendToChannel(channel.id, message);
  }, [gitOperation, repoId, outputState]);

  // ============================================
  // Sub-hooks
  // ============================================

  // Git remote operations (push, pull, fetch)
  const { pushWithOutput, pullWithOutput, fetchWithOutput } = useGitOperations({
    outputState,
    repoPath,
    repoId,
    autoSwitchToOutput,
    onSwitchToOutput,
    getGitChannel,
  });

  // Git staging operations (commit, stage)
  const { commitWithOutput, stageWithOutput } = useGitStagingOperations({
    outputState,
    repoPath,
    repoId,
    autoSwitchToOutput,
    onSwitchToOutput,
    getGitChannel,
  });

  // File watch heartbeat
  const {
    logFileWatchEvent,
    startWatchHeartbeat,
    stopWatchHeartbeat,
    resetHeartbeat,
    cleanup: cleanupHeartbeat,
  } = useFileWatchHeartbeat({
    outputState,
    verbose,
    enableWatchHeartbeat,
    getGitChannel,
  });

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      cleanupHeartbeat();
    };
  }, [cleanupHeartbeat]);

  // ============================================
  // Return
  // ============================================

  return {
    pushWithOutput,
    pullWithOutput,
    fetchWithOutput,
    commitWithOutput,
    stageWithOutput,
    logFileWatchEvent,
    startWatchHeartbeat,
    stopWatchHeartbeat,
    resetHeartbeat,
    getGitChannelId,
  };
}
