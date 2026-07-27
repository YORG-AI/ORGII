/**
 * useSessionManager Hook
 *
 * Centralized hook for loading the global sessions list. The hook is a
 * thin wrapper around the centralized session store and handles
 * cache-invalidation events; it does not own any "selected session" state
 * (the WorkStation-active session lives in `workstationActiveSessionIdAtom`
 * and the global event-pipeline session lives in `activeSessionIdAtom`).
 */
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import { createLogger } from "@src/hooks/logger";
import { reposAtom } from "@src/store/repo";
import {
  SESSION_CACHE_INVALIDATED_EVENT,
  SESSION_CACHE_INVALIDATION_KEY,
  Session,
  loadSessions as centralLoadSessions,
  getSessionCacheInvalidationTimestamp,
  resetSessionStore,
  sessionErrorAtom,
  sessionLastLoadedAtom,
  sessionLoadingAtom,
  sessionsAtom,
} from "@src/store/session";

const log = createLogger("useSessionManager");

export interface UseSessionManagerOptions {
  /** Auto-load sessions on mount (default: true) */
  autoLoad?: boolean;
}

export interface UseSessionManagerReturn {
  sessions: Session[];
  filteredSessions: Session[];
  sessionLoading: boolean;
  error: string | null;

  loadSessions: () => Promise<void>;

  isReady: boolean;
}

export function useSessionManager(
  options: UseSessionManagerOptions = {}
): UseSessionManagerReturn {
  const { autoLoad = true } = options;

  const sessions = useAtomValue(sessionsAtom);
  const sessionLoading = useAtomValue(sessionLoadingAtom);
  const error = useAtomValue(sessionErrorAtom);
  const lastLoadedAt = useAtomValue(sessionLastLoadedAtom);

  const repos = useAtomValue(reposAtom);

  // Mirror sessions.length in a ref so loadSessions can read it without
  // being recreated every time the list grows.  Without this, sessions.length
  // in the dep array causes loadSessions to change identity after every load,
  // which re-fires the autoLoad useEffect after every store update.
  const sessionsLengthRef = useRef(sessions.length);
  useEffect(() => {
    sessionsLengthRef.current = sessions.length;
  }, [sessions.length]);

  const loadSessions = useCallback(async () => {
    const invalidationTimestamp = getSessionCacheInvalidationTimestamp();
    const cacheWasInvalidated =
      invalidationTimestamp !== null &&
      invalidationTimestamp > 0 &&
      (!lastLoadedAt || invalidationTimestamp > lastLoadedAt);

    if (cacheWasInvalidated) {
      resetSessionStore();
      localStorage.removeItem(SESSION_CACHE_INVALIDATION_KEY);
    }

    try {
      await centralLoadSessions({
        forceRefresh: cacheWasInvalidated || sessionsLengthRef.current === 0,
      });
    } catch (err) {
      log.error("[useSessionManager] Failed to load sessions:", err);
    }
  }, [lastLoadedAt]);

  const forceRefresh = useCallback(async () => {
    resetSessionStore();
    localStorage.removeItem(SESSION_CACHE_INVALIDATION_KEY);
    try {
      await centralLoadSessions({ forceRefresh: true });
    } catch (err) {
      log.error("[useSessionManager] Failed to refresh sessions:", err);
    }
  }, []);

  useEffect(() => {
    if (autoLoad && repos.length > 0) {
      loadSessions();
    }
  }, [autoLoad, repos.length, loadSessions]);

  useEffect(() => {
    const handleCacheInvalidated = () => {
      forceRefresh();
    };

    window.addEventListener(
      SESSION_CACHE_INVALIDATED_EVENT,
      handleCacheInvalidated
    );

    return () => {
      window.removeEventListener(
        SESSION_CACHE_INVALIDATED_EVENT,
        handleCacheInvalidated
      );
    };
  }, [forceRefresh]);

  return {
    sessions,
    filteredSessions: sessions,
    sessionLoading,
    error,

    loadSessions,

    isReady: !sessionLoading && sessions.length >= 0,
  };
}

export default useSessionManager;
