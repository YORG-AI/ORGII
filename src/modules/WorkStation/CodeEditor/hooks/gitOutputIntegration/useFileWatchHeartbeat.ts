/**
 * File Watch Heartbeat Hook
 *
 * Manages file watch status logging and heartbeat functionality.
 * Shows idle status after periods of no file changes.
 */
import { useCallback, useRef } from "react";

import type {
  OutputChannel,
  UseGitOutputIntegrationOptions,
} from "@src/types/workstation/gitOutputIntegration";

import { formatTimestamp, formatWatchMessage } from "./formatters";

// ============================================
// Hook Options & Return Types
// ============================================

export interface UseFileWatchHeartbeatOptions extends Pick<
  UseGitOutputIntegrationOptions,
  "outputState" | "verbose" | "enableWatchHeartbeat"
> {
  /** Get or create the git channel */
  getGitChannel: () => OutputChannel;
}

export interface UseFileWatchHeartbeatReturn {
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
  /** Cleanup function for useEffect */
  cleanup: () => void;
}

// ============================================
// Constants
// ============================================

/** Interval to check for idle status (30 seconds) */
const HEARTBEAT_CHECK_INTERVAL = 30000;

/** Time after which to show idle message (1 minute) */
const IDLE_THRESHOLD = 60 * 1000;

// ============================================
// Hook
// ============================================

/**
 * Hook for managing file watch heartbeat and logging.
 */
export function useFileWatchHeartbeat(
  options: UseFileWatchHeartbeatOptions
): UseFileWatchHeartbeatReturn {
  const {
    outputState,
    verbose = false,
    enableWatchHeartbeat = true,
    getGitChannel,
  } = options;

  // Refs for heartbeat state
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastActivityRef = useRef<number>(0);
  const watchActiveRef = useRef<boolean>(false);
  const idleReportedRef = useRef<boolean>(false);

  /**
   * Log file watch events to the output channel.
   * Only logs if verbose mode is enabled.
   */
  const logFileWatchEvent = useCallback(
    (eventType: "start" | "change" | "end", details?: string) => {
      if (!verbose) return;

      const channel = getGitChannel();
      const timestamp = formatTimestamp();
      const message = formatWatchMessage(timestamp, eventType, details);

      outputState.appendToChannel(channel.id, message);

      // Update state based on event type
      if (eventType === "start") {
        watchActiveRef.current = true;
        idleReportedRef.current = false;
      } else if (eventType === "change") {
        lastActivityRef.current = Date.now();
        idleReportedRef.current = false;
      } else if (eventType === "end") {
        watchActiveRef.current = false;
      }
    },
    [verbose, getGitChannel, outputState]
  );

  /**
   * Start the file watch heartbeat.
   * Periodically checks if the watcher has been idle and logs a message.
   */
  const startWatchHeartbeat = useCallback(() => {
    if (!enableWatchHeartbeat) return;

    // Clear existing interval
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }

    watchActiveRef.current = true;
    lastActivityRef.current = Date.now();
    idleReportedRef.current = false;

    // Check periodically for idle status
    heartbeatIntervalRef.current = setInterval(() => {
      if (!watchActiveRef.current) return;

      const now = Date.now();
      const idleTime = now - lastActivityRef.current;

      // Show idle message if inactive for threshold duration
      if (idleTime >= IDLE_THRESHOLD && !idleReportedRef.current) {
        const channel = getGitChannel();
        const timestamp = formatTimestamp();
        const minutesIdle = Math.floor(idleTime / IDLE_THRESHOLD);
        const details = `in the last ${minutesIdle} minute${minutesIdle > 1 ? "s" : ""}`;
        const message = formatWatchMessage(timestamp, "idle", details);

        outputState.appendToChannel(channel.id, message);
        idleReportedRef.current = true;
      }
    }, HEARTBEAT_CHECK_INTERVAL);
  }, [enableWatchHeartbeat, getGitChannel, outputState]);

  /**
   * Stop the file watch heartbeat.
   */
  const stopWatchHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    watchActiveRef.current = false;
  }, []);

  /**
   * Reset the heartbeat timer.
   * Call this when file changes are detected.
   */
  const resetHeartbeat = useCallback(() => {
    lastActivityRef.current = Date.now();
    idleReportedRef.current = false;
  }, []);

  /**
   * Cleanup function for useEffect.
   */
  const cleanup = useCallback(() => {
    stopWatchHeartbeat();
  }, [stopWatchHeartbeat]);

  return {
    logFileWatchEvent,
    startWatchHeartbeat,
    stopWatchHeartbeat,
    resetHeartbeat,
    cleanup,
  };
}
