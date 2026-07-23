import { useEffect } from "react";

import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import type { SessionSyncRefs } from "./sessionSyncTypes";
import { EVENT_STORE_CACHE_SYNC_INTERVAL_MS } from "./sessionSyncUtils";

const EVENT_STORE_CACHE_QUIET_MS = 2_000;

function saveSessionEventsToCache(sessionId: string): Promise<number> {
  if (isImportedHistorySession(sessionId)) return Promise.resolve(0);
  return eventStoreProxy.saveToCache(sessionId);
}

export interface EventStoreCachePersistenceScheduler {
  markDirty(version: number): void;
  flush(): void;
  dispose(): void;
}

/**
 * Event-driven, single-flight EventStore persistence with both a short quiet
 * window and a hard maximum durability delay.
 *
 * The old fixed 30-second interval woke forever while idle. This scheduler
 * owns no timer until a new snapshot version arrives. Sustained streaming
 * resets only the quiet timer; the maximum-delay timer guarantees that an
 * active stream is checkpointed at least every 30 seconds.
 */
export function createEventStoreCachePersistenceScheduler(
  save: () => Promise<unknown>,
  quietMs = EVENT_STORE_CACHE_QUIET_MS,
  maximumDelayMs = EVENT_STORE_CACHE_SYNC_INTERVAL_MS
): EventStoreCachePersistenceScheduler {
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let maximumTimer: ReturnType<typeof setTimeout> | null = null;
  let latestVersion: number | null = null;
  let savedVersion: number | null = null;
  let inFlight = false;
  let disposed = false;

  const clearTimers = (): void => {
    if (quietTimer !== null) clearTimeout(quietTimer);
    if (maximumTimer !== null) clearTimeout(maximumTimer);
    quietTimer = null;
    maximumTimer = null;
  };

  const flush = (): void => {
    clearTimers();
    if (
      disposed ||
      inFlight ||
      latestVersion === null ||
      latestVersion === savedVersion
    ) {
      return;
    }

    const savingVersion = latestVersion;
    inFlight = true;
    void save().finally(() => {
      inFlight = false;
      if (disposed) return;
      savedVersion = savingVersion;
      if (latestVersion !== savedVersion) {
        quietTimer = setTimeout(flush, quietMs);
        maximumTimer = setTimeout(flush, maximumDelayMs);
      }
    });
  };

  return {
    markDirty(version: number): void {
      if (disposed || version === latestVersion) return;
      latestVersion = version;
      if (quietTimer !== null) clearTimeout(quietTimer);
      quietTimer = setTimeout(flush, quietMs);
      if (maximumTimer === null) {
        maximumTimer = setTimeout(flush, maximumDelayMs);
      }
    },
    flush,
    dispose(): void {
      if (disposed) return;
      // Preserve the previous unmount/session-switch durability guarantee.
      flush();
      disposed = true;
      clearTimers();
    },
  };
}

export function useEventStoreCacheSync(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId || isImportedHistorySession(sessionId)) return;

    const scheduler = createEventStoreCachePersistenceScheduler(() =>
      saveSessionEventsToCache(sessionId)
    );
    const unsubscribe = eventStoreProxy.subscribeSession(
      sessionId,
      (snapshot) => scheduler.markDirty(snapshot.version)
    );
    const flushWhenHidden = (): void => {
      if (document.visibilityState === "hidden") scheduler.flush();
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", flushWhenHidden);
      scheduler.dispose();
    };
  }, [sessionId]);
}

export function useSessionSyncCleanup(
  refs: Pick<SessionSyncRefs, "prevSessionIdRef" | "handlerRef">
): void {
  useEffect(() => {
    return () => {
      if (refs.prevSessionIdRef.current) {
        saveSessionEventsToCache(refs.prevSessionIdRef.current);
      }
      if (refs.handlerRef.current) {
        refs.handlerRef.current.dispose();
        refs.handlerRef.current = null;
      }
    };
  }, [refs.handlerRef, refs.prevSessionIdRef]);
}

export function disposeCurrentHandler(
  refs: Pick<SessionSyncRefs, "handlerRef">
): void {
  if (refs.handlerRef.current) {
    refs.handlerRef.current.dispose();
    refs.handlerRef.current = null;
  }
}

export function resetReloadGuardForSession(
  sessionId: string,
  refs: Pick<SessionSyncRefs, "prevSessionIdRef" | "prevReloadEpochRef">
): void {
  if (refs.prevSessionIdRef.current === sessionId) {
    refs.prevSessionIdRef.current = null;
    refs.prevReloadEpochRef.current = 0;
  }
}
