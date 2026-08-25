/**
 * File Watch Output Integration Hook
 *
 * Integrates file watch events with the Output panel's Filesync channel.
 * Displays file system changes, git status updates, and watcher health.
 * Also notifies the file content cache when files change externally.
 */
import { useCallback, useEffect, useRef } from "react";

import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import { onExternalFileChange } from "@src/modules/WorkStation/CodeEditor/hooks/fileContent/useFileContent";
import type { UseOutputChannelsReturn } from "@src/types/workstation/output";

interface GitFile {
  path: string;
  status: string;
  staged: boolean;
}

export interface UseFileWatchOutputIntegrationOptions {
  /** Output panel state */
  outputState: UseOutputChannelsReturn;
  /** Repository ID to watch */
  repoId: string;
  /** Repository path */
  repoPath: string;
  /** Enable file watch logging (default: true) */
  enabled?: boolean;
}

export function useFileWatchOutputIntegration(
  options: UseFileWatchOutputIntegrationOptions
) {
  const { outputState, repoId, repoPath, enabled = true } = options;

  // Track state
  const channelIdRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const previousFilesRef = useRef<Map<string, GitFile>>(new Map());
  // Dedup repeated watcher_health lines: a single flaky/non-git repo otherwise
  // floods the Filesync channel with identical "Health: degraded" lines on the
  // watcher's 60s loop. Key = `${status}:${reason}` of the last logged event.
  const lastHealthSignatureRef = useRef<string | null>(null);

  // Store outputState functions in refs to avoid dependency issues
  // This prevents the infinite loop caused by outputState.channels changing on every append
  const outputStateRef = useRef(outputState);
  useEffect(() => {
    outputStateRef.current = outputState;
  }, [outputState]);

  // Format timestamp - local time with subdued italic styling
  const formatTimestamp = useCallback(() => {
    const now = new Date();
    // Format as YYYY-MM-DD HH:MM:SS.mmm
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    const ms = now.getMilliseconds().toString().padStart(3, "0");
    const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
    // Apply text-3 color (dimmed) and italic using ANSI codes
    return `\x1b[2m\x1b[3m${timestamp}\x1b[0m`;
  }, []);

  // Get channel ID (create once if needed)
  // Uses ref to avoid dependency on outputState.channels which changes on every append
  const getChannelId = useCallback(() => {
    if (channelIdRef.current) {
      return channelIdRef.current;
    }

    const currentOutputState = outputStateRef.current;
    const existing = currentOutputState.channels.find(
      (ch) => ch.type === "filesync"
    );
    if (existing) {
      channelIdRef.current = existing.id;
      return existing.id;
    }

    const id = currentOutputState.createChannel("Filesync", "filesync");
    channelIdRef.current = id;
    return id;
  }, []);

  // Log to channel - stable callback that uses refs
  const log = useCallback(
    (message: string) => {
      const channelId = getChannelId();
      if (channelId) {
        const timestamp = formatTimestamp();
        outputStateRef.current.appendToChannel(
          channelId,
          `${timestamp} ${message}\n`
        );
      }
    },
    [getChannelId, formatTimestamp]
  );

  // Main effect: Set up WebSocket event listeners
  // IMPORTANT: Only depend on primitive values (enabled, repoId, repoPath) to avoid infinite loops
  // The log function uses refs internally so it's stable and doesn't need to be a dependency
  useEffect(() => {
    if (!enabled) return;
    if (!repoId || repoId === repoPath) return;

    const ws = getCodeEditorWebSocket();
    if (!ws) {
      return;
    }

    let mounted = true;
    const unsubscribeFns: Array<() => void> = [];

    // Reset previous files when repo changes (prevent stale state)
    previousFilesRef.current.clear();
    lastHealthSignatureRef.current = null;

    // Listen to repo:status_updated events - parse file changes
    const unsubscribe1 = ws.on("repo:status_updated", (data) => {
      if (!mounted) return;

      const payload = data as {
        type: string;
        repo_id: string;
        status: {
          staged?: number;
          unstaged?: number;
          untracked?: number;
          files?: Array<{
            path: string;
            status: string;
            staged: boolean;
          }>;
        };
      };

      if (payload.repo_id !== repoId) return;

      const files = payload.status?.files || [];
      const currentFiles = new Map<string, GitFile>();

      // Build current state
      for (const file of files) {
        currentFiles.set(file.path, file);
      }

      // Compare with previous state and log changes
      const previousFiles = previousFilesRef.current;

      // Find new or modified files
      for (const [path, file] of currentFiles) {
        const prev = previousFiles.get(path);
        const relativePath = path.replace(/^\//, "");

        if (!prev) {
          // New file in git status
          const color = file.status === "?" ? "\x1b[36m" : "\x1b[33m";
          const action = file.status === "?" ? "untracked" : "modified";
          log(
            `${color}[File Watch]\x1b[0m File ${action}: \x1b[36m${relativePath}\x1b[0m`
          );
          // Notify file content cache of external change
          onExternalFileChange(relativePath);
        } else if (prev.status !== file.status || prev.staged !== file.staged) {
          // Status changed
          const action = file.staged ? "staged" : "modified";
          log(
            `\x1b[33m[File Watch]\x1b[0m File ${action}: \x1b[36m${relativePath}\x1b[0m`
          );
          // Notify file content cache of external change
          onExternalFileChange(relativePath);
        }
      }

      // Find removed files (were in git status, now clean)
      for (const [path] of previousFiles) {
        if (!currentFiles.has(path)) {
          const relativePath = path.replace(/^\//, "");
          log(
            `\x1b[32m[File Watch]\x1b[0m File clean: \x1b[36m${relativePath}\x1b[0m`
          );
        }
      }

      // Update previous state
      previousFilesRef.current = currentFiles;
    });
    unsubscribeFns.push(unsubscribe1);

    // Listen to repo:watcher_health events
    const unsubscribe2 = ws.on("repo:watcher_health", (data) => {
      if (!mounted) return;

      const payload = data as {
        type: string;
        repo_id: string;
        status: string;
        reason?: string;
      };

      if (payload.repo_id !== repoId) return;

      const status = payload.status;

      // Suppress consecutive duplicate health events for the same repo so a
      // single degraded/failed repo doesn't spam the channel every poll cycle.
      const signature = `${status}:${payload.reason ?? ""}`;
      if (lastHealthSignatureRef.current === signature) return;
      lastHealthSignatureRef.current = signature;

      let color = "\x1b[32m";
      if (status === "degraded") color = "\x1b[33m";
      else if (status === "failed") color = "\x1b[31m";

      log(`${color}[File Watch]\x1b[0m Health: ${status}`);

      if (payload.reason) {
        log(`  \x1b[90m${payload.reason}\x1b[0m`);
      }
    });
    unsubscribeFns.push(unsubscribe2);

    // Log initialization
    if (!initializedRef.current) {
      initializedRef.current = true;
      log(`\x1b[90m[File Watch]\x1b[0m Watching: ${repoPath}`);
    } else {
      // Repo changed - log switch
      log(`\x1b[90m[File Watch]\x1b[0m Switched to: ${repoPath}`);
    }

    return () => {
      mounted = false;

      // Log cleanup - use ref to avoid stale closure
      if (repoId) {
        const msg = `\x1b[90m[File Watch]\x1b[0m Stopped watching: ${repoPath}`;
        try {
          const channelId = channelIdRef.current;
          const currentOutputState = outputStateRef.current;
          if (
            channelId &&
            currentOutputState.channels.find((ch) => ch.id === channelId)
          ) {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, "0");
            const day = String(now.getDate()).padStart(2, "0");
            const hours = String(now.getHours()).padStart(2, "0");
            const minutes = String(now.getMinutes()).padStart(2, "0");
            const seconds = String(now.getSeconds()).padStart(2, "0");
            const ms = now.getMilliseconds().toString().padStart(3, "0");
            const timestamp = `\x1b[2m\x1b[3m${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}\x1b[0m`;
            currentOutputState.appendToChannel(
              channelId,
              `${timestamp} ${msg}\n`
            );
          }
        } catch (_e) {
          // Ignore errors during cleanup
        }
      }

      for (const fn of unsubscribeFns) {
        try {
          fn();
        } catch (_e) {
          // Ignore cleanup errors
        }
      }
    };
  }, [enabled, repoId, repoPath, log]);

  // Listen for manual file save events (editor internal saves)
  useEffect(() => {
    if (!enabled) return;

    const handleFileSaved = (event: Event) => {
      const customEvent = event as CustomEvent<{ path: string }>;
      const filePath = customEvent.detail.path;
      const relativePath = filePath.replace(repoPath, "").replace(/^[/\\]/, "");

      log(
        `\x1b[33m[File Watch]\x1b[0m File saved: \x1b[36m${relativePath}\x1b[0m`
      );
    };

    window.addEventListener("filesync:file-saved", handleFileSaved);

    return () => {
      window.removeEventListener("filesync:file-saved", handleFileSaved);
    };
  }, [enabled, repoPath, log]);

  return {};
}
