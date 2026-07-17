/**
 * useBrowserConsole
 *
 * Hook for managing browser console log state.
 * Polls webview for console logs via Rust command.
 * Caches logs per session/tab for persistence when switching.
 *
 * NOTE: We use polling instead of events because Tauri APIs
 * are not available inside inline webviews loading external URLs.
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useVisiblePolling } from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("useBrowserConsole");
const consoleLogRequests = new Map<string, Promise<RustConsoleEntry[]>>();

function fetchConsoleLogs(label: string): Promise<RustConsoleEntry[]> {
  const existing = consoleLogRequests.get(label);
  if (existing) return existing;

  const request = invoke<RustConsoleEntry[]>("get_webview_console_logs", {
    label,
  }).finally(() => {
    if (consoleLogRequests.get(label) === request) {
      consoleLogRequests.delete(label);
    }
  });
  consoleLogRequests.set(label, request);
  return request;
}

// ============================================
// Types
// ============================================

export type LogLevel = "log" | "warn" | "error" | "info" | "debug" | "trace";

export interface ConsoleEntry {
  id: string;
  level: LogLevel;
  message: string;
  timestamp: number;
  url: string;
  stack?: string;
}

/** Entry format from Rust backend */
interface RustConsoleEntry {
  level: string;
  message: string;
  timestamp: number;
  url: string;
  stack: string | null;
}

/** Cache entry for a session's logs */
interface SessionLogCache {
  entries: ConsoleEntry[];
  errorCount: number;
  warningCount: number;
}

export interface UseBrowserConsoleOptions {
  /** Maximum entries to keep per session (default: 500) */
  maxEntries?: number;
  /** Maximum message length before truncation (default: 2000) */
  maxMessageLength?: number;
  /** Maximum entries to add per poll (rate limiting, default: 50) */
  maxEntriesPerPoll?: number;
  /** Whether to deduplicate repeated consecutive logs (default: true) */
  deduplicateRepeated?: boolean;
  /** Whether to poll for logs (default: true) */
  enabled?: boolean;
  /** Session ID for caching (required for per-tab logs) */
  sessionId?: string;
  /** Webview label to poll (required for polling) */
  webviewLabel?: string;
  /** Poll interval in ms (default: 1000) */
  pollInterval?: number;
}

export interface UseBrowserConsoleReturn {
  /** Console entries for current session */
  entries: ConsoleEntry[];
  /** Count of error entries for current session */
  errorCount: number;
  /** Count of warning entries for current session */
  warningCount: number;
  /** Clear entries for current session */
  clearEntries: () => void;
  /** Clear entries for all sessions */
  clearAllEntries: () => void;
  /** Add a manual entry (for testing) */
  addEntry: (level: LogLevel, message: string, stack?: string) => void;
  /** Manually trigger a poll */
  pollNow: () => Promise<void>;
  /** Set the webview label to poll */
  setWebviewLabel: (label: string) => void;
  /** Set the session ID (switches cached logs) */
  setSessionId: (sessionId: string) => void;
}

// ============================================
// Hook
// ============================================

export function useBrowserConsole(
  options: UseBrowserConsoleOptions = {}
): UseBrowserConsoleReturn {
  const {
    maxEntries = 500,
    maxMessageLength = 2000,
    maxEntriesPerPoll = 50,
    deduplicateRepeated = true,
    enabled = true,
    sessionId: initialSessionId,
    webviewLabel: initialLabel,
    pollInterval = 1000,
  } = options;

  // Current session state
  const [sessionId, setSessionId] = useState<string>(initialSessionId || "");
  const [webviewLabel, setWebviewLabel] = useState<string>(initialLabel || "");

  // Cache: sessionId -> logs (capped to prevent memory growth)
  const MAX_SESSION_CACHE = 10;
  const cacheRef = useRef<Map<string, SessionLogCache>>(new Map());

  // Current session's entries (state)
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);

  const entryIdCounter = useRef(0);

  // Generate unique ID
  const generateId = useCallback(() => {
    entryIdCounter.current += 1;
    return `console-${Date.now()}-${entryIdCounter.current}`;
  }, []);

  // Get or create cache entry for a session
  const getSessionCache = useCallback((sid: string): SessionLogCache => {
    if (!cacheRef.current.has(sid)) {
      // Evict oldest sessions if over limit
      if (cacheRef.current.size >= MAX_SESSION_CACHE) {
        const firstKey = cacheRef.current.keys().next().value;
        if (firstKey) cacheRef.current.delete(firstKey);
      }
      cacheRef.current.set(sid, {
        entries: [],
        errorCount: 0,
        warningCount: 0,
      });
    }
    return cacheRef.current.get(sid)!;
  }, []);

  // Update cache and state for current session
  const updateSessionEntries = useCallback(
    (sid: string, newEntries: ConsoleEntry[]) => {
      const cache = getSessionCache(sid);
      cache.entries = newEntries;

      // Recompute counts
      let errors = 0;
      let warnings = 0;
      for (const entry of newEntries) {
        if (entry.level === "error") errors++;
        else if (entry.level === "warn") warnings++;
      }
      cache.errorCount = errors;
      cache.warningCount = warnings;

      // Update state if this is the current session
      if (sid === sessionId) {
        setEntries(newEntries);
      }
    },
    [sessionId, getSessionCache]
  );

  // Sync entries with cache when sessionId changes
  useEffect(() => {
    const cache = sessionId ? getSessionCache(sessionId) : null;
    setEntries(cache ? cache.entries : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]); // Deliberately omit getSessionCache to avoid re-running on every render

  // Add entry manually
  const addEntry = useCallback(
    (level: LogLevel, message: string, stack?: string) => {
      if (!sessionId) return;

      const entry: ConsoleEntry = {
        id: generateId(),
        level,
        message,
        timestamp: Date.now(),
        url: "",
        stack,
      };

      const cache = getSessionCache(sessionId);
      let newEntries = [...cache.entries, entry];
      if (newEntries.length > maxEntries) {
        newEntries = newEntries.slice(-maxEntries);
      }

      updateSessionEntries(sessionId, newEntries);
    },
    [sessionId, generateId, maxEntries, getSessionCache, updateSessionEntries]
  );

  // Clear entries for current session
  const clearEntries = useCallback(() => {
    if (!sessionId) return;
    updateSessionEntries(sessionId, []);
  }, [sessionId, updateSessionEntries]);

  // Clear entries for all sessions
  const clearAllEntries = useCallback(() => {
    cacheRef.current.clear();
    setEntries([]);
  }, []);

  // Truncate message if too long
  const truncateMessage = useCallback(
    (message: string): string => {
      if (message.length <= maxMessageLength) return message;
      return (
        message.slice(0, maxMessageLength) +
        `... [truncated ${message.length - maxMessageLength} chars]`
      );
    },
    [maxMessageLength]
  );

  // Check if two entries are duplicates (for deduplication)
  const isDuplicate = useCallback(
    (entry1: ConsoleEntry, entry2: ConsoleEntry): boolean => {
      return (
        entry1.level === entry2.level &&
        entry1.message === entry2.message &&
        entry1.url === entry2.url
      );
    },
    []
  );

  // Poll for console logs from webview
  const pollNow = useCallback(
    async (signal?: AbortSignal) => {
      if (!webviewLabel || !sessionId) return;

      try {
        const rustEntries = await fetchConsoleLogs(webviewLabel);
        if (signal?.aborted) return;

        if (rustEntries && rustEntries.length > 0) {
          const cache = getSessionCache(sessionId);

          // Rate limit: only process up to maxEntriesPerPoll
          const limitedEntries = rustEntries.slice(0, maxEntriesPerPoll);
          const droppedCount = rustEntries.length - limitedEntries.length;

          // Transform entries with truncation
          let newEntries: ConsoleEntry[] = limitedEntries.map((entry) => ({
            id: generateId(),
            level: (entry.level as LogLevel) || "log",
            message: truncateMessage(entry.message || ""),
            timestamp: entry.timestamp || Date.now(),
            url: entry.url || "",
            stack: entry.stack ? truncateMessage(entry.stack) : undefined,
          }));

          // Deduplicate: collapse repeated consecutive logs
          if (deduplicateRepeated && newEntries.length > 0) {
            const dedupedEntries: ConsoleEntry[] = [];
            let repeatCount = 0;
            let lastEntry: ConsoleEntry | null =
              cache.entries.length > 0
                ? cache.entries[cache.entries.length - 1]
                : null;

            for (const entry of newEntries) {
              if (lastEntry && isDuplicate(lastEntry, entry)) {
                repeatCount++;
              } else {
                // Add repeat indicator to previous entry if needed
                if (repeatCount > 0 && dedupedEntries.length > 0) {
                  const prev = dedupedEntries[dedupedEntries.length - 1];
                  prev.message = `${prev.message} [×${repeatCount + 1}]`;
                }
                dedupedEntries.push(entry);
                lastEntry = entry;
                repeatCount = 0;
              }
            }

            // Handle trailing repeats
            if (repeatCount > 0 && dedupedEntries.length > 0) {
              const prev = dedupedEntries[dedupedEntries.length - 1];
              prev.message = `${prev.message} [×${repeatCount + 1}]`;
            }

            newEntries = dedupedEntries;
          }

          // Add rate limit warning if entries were dropped
          if (droppedCount > 0) {
            newEntries.push({
              id: generateId(),
              level: "warn",
              message: `[DevTools] Rate limited: ${droppedCount} log entries dropped`,
              timestamp: Date.now(),
              url: "",
            });
          }

          let combined = [...cache.entries, ...newEntries];
          if (combined.length > maxEntries) {
            combined = combined.slice(-maxEntries);
          }

          updateSessionEntries(sessionId, combined);
        }
      } catch (error) {
        // Silently ignore - webview might not exist yet or be closing
        if (
          process.env.NODE_ENV === "development" &&
          !String(error).includes("not found")
        ) {
          log.debug("[useBrowserConsole] Poll error:", error);
        }
      }
    },
    [
      webviewLabel,
      sessionId,
      generateId,
      maxEntries,
      maxEntriesPerPoll,
      deduplicateRepeated,
      truncateMessage,
      isDuplicate,
      getSessionCache,
      updateSessionEntries,
    ]
  );

  useVisiblePolling({
    enabled: enabled && !!webviewLabel && !!sessionId && pollInterval > 0,
    intervalMs: pollInterval,
    poll: pollNow,
  });

  // Compute counts from current entries
  const { errorCount, warningCount } = useMemo(() => {
    let errors = 0;
    let warnings = 0;

    for (const entry of entries) {
      if (entry.level === "error") errors++;
      else if (entry.level === "warn") warnings++;
    }

    return { errorCount: errors, warningCount: warnings };
  }, [entries]);

  return {
    entries,
    errorCount,
    warningCount,
    clearEntries,
    clearAllEntries,
    addEntry,
    pollNow,
    setWebviewLabel,
    setSessionId,
  };
}

export default useBrowserConsole;
