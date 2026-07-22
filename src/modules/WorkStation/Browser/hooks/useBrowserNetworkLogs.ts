/**
 * useBrowserNetworkLogs
 *
 * Hook for managing browser network log state.
 * Polls webview for network logs via Rust command.
 * Caches logs per session/tab for persistence when switching.
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createLogger } from "@src/hooks/logger";
import { startVisibilityAwarePoller } from "@src/hooks/workStation/browser/visibilityAwarePoller";

const log = createLogger("useBrowserNetworkLogs");

// ============================================
// Types
// ============================================

export interface NetworkEntry {
  id: string;
  type: "fetch" | "xhr";
  method: string;
  url: string;
  startTime: number;
  status: number | null;
  duration: number | null;
  size: string | null;
  error: string | null;
}

/** Entry format from Rust backend */
interface RustNetworkEntry {
  id: string;
  type: string;
  method: string;
  url: string;
  startTime: number;
  status: number | null;
  duration: number | null;
  size: string | null;
  error: string | null;
}

/** Cache entry for a session's logs */
interface SessionNetworkCache {
  entries: NetworkEntry[];
  errorCount: number;
}

export interface UseBrowserNetworkLogsOptions {
  /** Maximum entries to keep per session (default: 200) */
  maxEntries?: number;
  /** Whether to poll for logs (default: true) */
  enabled?: boolean;
  /** Session ID for caching (required for per-tab logs) */
  sessionId?: string;
  /** Webview label to poll (required for polling) */
  webviewLabel?: string;
  /** Poll interval in ms (default: 1000) */
  pollInterval?: number;
}

export interface UseBrowserNetworkLogsReturn {
  /** Network entries for current session */
  entries: NetworkEntry[];
  /** Count of failed requests for current session */
  errorCount: number;
  /** Clear entries for current session */
  clearEntries: () => void;
  /** Clear entries for all sessions */
  clearAllEntries: () => void;
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

export function useBrowserNetworkLogs(
  options: UseBrowserNetworkLogsOptions = {}
): UseBrowserNetworkLogsReturn {
  const {
    maxEntries = 200,
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
  const cacheRef = useRef<Map<string, SessionNetworkCache>>(new Map());

  // Current session's entries (state)
  const [entries, setEntries] = useState<NetworkEntry[]>([]);

  // Get or create cache entry for a session
  const getSessionCache = useCallback((sid: string): SessionNetworkCache => {
    if (!cacheRef.current.has(sid)) {
      // Evict oldest sessions if over limit
      if (cacheRef.current.size >= MAX_SESSION_CACHE) {
        const firstKey = cacheRef.current.keys().next().value;
        if (firstKey) cacheRef.current.delete(firstKey);
      }
      cacheRef.current.set(sid, {
        entries: [],
        errorCount: 0,
      });
    }
    return cacheRef.current.get(sid)!;
  }, []);

  // Update cache and state for current session
  const updateSessionEntries = useCallback(
    (sid: string, newEntries: NetworkEntry[]) => {
      const cache = getSessionCache(sid);
      cache.entries = newEntries;

      // Recompute error count
      let errors = 0;
      for (const entry of newEntries) {
        if (entry.error || (entry.status && entry.status >= 400)) errors++;
      }
      cache.errorCount = errors;

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

  // Poll for network logs from webview
  const pollNow = useCallback(async () => {
    if (!webviewLabel || !sessionId) return;

    try {
      const rustEntries = await invoke<RustNetworkEntry[]>(
        "get_webview_network_logs",
        { label: webviewLabel }
      );

      if (rustEntries && rustEntries.length > 0) {
        const cache = getSessionCache(sessionId);

        // Transform entries
        const newEntries: NetworkEntry[] = rustEntries.map((entry) => ({
          id: entry.id,
          type: (entry.type as "fetch" | "xhr") || "fetch",
          method: entry.method || "GET",
          url: entry.url || "",
          startTime: entry.startTime || Date.now(),
          status: entry.status,
          duration: entry.duration,
          size: entry.size,
          error: entry.error,
        }));

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
        log.debug("[useBrowserNetworkLogs] Poll error:", error);
      }
    }
  }, [
    webviewLabel,
    sessionId,
    maxEntries,
    getSessionCache,
    updateSessionEntries,
  ]);

  // Start/stop polling
  useEffect(() => {
    if (
      !enabled ||
      !webviewLabel ||
      !sessionId ||
      pollInterval <= 0 ||
      typeof document === "undefined"
    ) {
      return;
    }

    return startVisibilityAwarePoller(document, pollNow, pollInterval);
  }, [enabled, webviewLabel, sessionId, pollInterval, pollNow]);

  // Compute error count from current entries
  const errorCount = useMemo(() => {
    let errors = 0;
    for (const entry of entries) {
      if (entry.error || (entry.status && entry.status >= 400)) errors++;
    }
    return errors;
  }, [entries]);

  return {
    entries,
    errorCount,
    clearEntries,
    clearAllEntries,
    pollNow,
    setWebviewLabel,
    setSessionId,
  };
}

export default useBrowserNetworkLogs;
