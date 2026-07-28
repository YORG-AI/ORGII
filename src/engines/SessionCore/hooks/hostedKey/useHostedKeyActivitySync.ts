/**
 * useHostedKeyActivitySync Hook
 *
 * Manages synchronization of hosted-key (ORGII key) session activity using
 * Redis Streams.
 *
 * Protocol:
 * 1. GET /hosted-key-activity → Load local history
 * 2. GET /hosted-key-cursor → Get cursor (e.g., "1702345678901-5")
 * 3. WS /api/ws?session_id=xxx&start_from=cursor → New events only
 * 4. Buffer 1-2s → POST /hosted-key-activity batch
 * 5. On reconnect → Repeat from step 2
 *
 * Features:
 * - Loads historical activity from local storage on init
 * - Provides cursor for WebSocket connection resumption
 * - Buffers incoming WS events and batch-stores them
 * - Handles reconnection with proper cursor resumption
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type HostedKeyActivityEvent,
  compareStreamIds,
  hostedKeyActivityApi,
} from "@src/api/http/session/hostedKey";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { processChunksRust } from "@src/engines/SessionCore/ingestion/rustBridge";
import { createLogger } from "@src/hooks/logger";
import type { ActivityChunk } from "@src/types/session/session";

import { eventToChunk, isEmptyThinkingEndFrame } from "./hostedKeyEventUtils";

const log = createLogger("CloudActivitySync");

// ============================================
// Constants
// ============================================

/** Buffer time before flushing events to storage (ms) */
const BUFFER_FLUSH_INTERVAL = 1500;

/** Maximum events per batch store request */
const MAX_BATCH_SIZE = 500;
const MAX_BUFFER_EVENTS = 2_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_SINGLE_EVENT_BYTES = 256 * 1024;

function estimateEventBytes(event: HostedKeyActivityEvent): number {
  try {
    return JSON.stringify(event).length * 2;
  } catch {
    return MAX_SINGLE_EVENT_BYTES + 1;
  }
}

function wouldOverflowBuffer(
  eventCount: number,
  bufferedBytes: number,
  eventBytes: number
): boolean {
  return (
    eventBytes > MAX_SINGLE_EVENT_BYTES ||
    eventCount >= MAX_BUFFER_EVENTS ||
    bufferedBytes + eventBytes > MAX_BUFFER_BYTES
  );
}

// ============================================
// Types
// ============================================

export interface UseHostedKeyActivitySyncOptions {
  /** Session ID to sync activity for */
  sessionId: string | null;
  /** Whether sync is enabled */
  enabled?: boolean;
  /** Debug logging */
  debug?: boolean;
  /** Callback when historical events are loaded */
  onHistoryLoaded?: (events: SessionEvent[]) => void;
  /** Callback when new events are received */
  onEventsReceived?: (events: SessionEvent[]) => void;
}

export interface UseHostedKeyActivitySyncReturn {
  /** Current cursor for WebSocket start_from */
  cursor: string;
  /** Whether initial history is loading */
  isLoadingHistory: boolean;
  /** Whether sync is ready (history loaded, cursor available) */
  isReady: boolean;
  /** Error state */
  error: string | null;
  /** Process incoming WS event (buffers and stores) */
  processEvent: (event: HostedKeyActivityEvent) => void;
  /** Force flush buffered events to storage */
  flushBuffer: () => Promise<void>;
  /** Refresh cursor (call on reconnect) */
  refreshCursor: () => Promise<string>;
  /** Load more historical activity */
  loadMoreHistory: (after?: string) => Promise<SessionEvent[]>;
}

// ============================================
// Hook Implementation
// ============================================

export function useHostedKeyActivitySync(
  options: UseHostedKeyActivitySyncOptions
): UseHostedKeyActivitySyncReturn {
  const {
    sessionId,
    enabled = true,
    debug = false,
    onHistoryLoaded,
    onEventsReceived,
  } = options;

  // ============================================
  // State
  // ============================================

  const [cursor, setCursor] = useState<string>("0");
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ============================================
  // Refs
  // ============================================

  /** Event buffer for batching */
  const eventBufferRef = useRef<HostedKeyActivityEvent[]>([]);
  const eventBufferBytesRef = useRef(0);
  const overflowWarnedRef = useRef(false);
  /** Flush timer */
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Session ID ref to handle async operations */
  const sessionIdRef = useRef<string | null>(sessionId);
  /** Track initialization */
  const initializedRef = useRef<string | null>(null);
  /** Callback refs for stability */
  const onHistoryLoadedRef = useRef(onHistoryLoaded);
  const onEventsReceivedRef = useRef(onEventsReceived);
  /** Mirror cursor state in a ref so processEvent always reads the latest
   *  value without being recreated on every cursor update. */
  const cursorRef = useRef<string>("0");

  // Keep refs in sync
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    onHistoryLoadedRef.current = onHistoryLoaded;
  }, [onHistoryLoaded]);

  useEffect(() => {
    onEventsReceivedRef.current = onEventsReceived;
  }, [onEventsReceived]);

  // ============================================
  // Buffer Management
  // ============================================

  /**
   * Flush buffered events to local storage
   */
  const flushBuffer = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || eventBufferRef.current.length === 0) return;

    // Clear the timer
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    // Take events from buffer
    const eventsToStore = eventBufferRef.current.splice(0, MAX_BATCH_SIZE);
    const batchBytes = eventsToStore.reduce(
      (total, event) => total + estimateEventBytes(event),
      0
    );
    eventBufferBytesRef.current = Math.max(
      0,
      eventBufferBytesRef.current - batchBytes
    );

    if (eventsToStore.length === 0) return;

    if (debug) {
      // Debug: flushing buffer
    }

    try {
      const response = await hostedKeyActivityApi.storeHostedKeyActivityBatch(
        sid,
        eventsToStore
      );

      if (sessionIdRef.current !== sid) return;

      if (response?.status === 0 && response.data) {
        overflowWarnedRef.current = false;
        // Keep ref + state in lockstep so the next processEvent's
        // dedup check sees the most recent cursor regardless of whether
        // the state has flushed through React yet.
        cursorRef.current = response.data.cursor;
        setCursor(response.data.cursor);

        if (debug) {
          // Debug: cursor updated
        }
      }
    } catch (err) {
      log.error("[CloudActivitySync] Failed to store events:", err);
      // Only re-add events if still the same session
      if (sessionIdRef.current === sid) {
        // Failed older events take precedence over newer buffered events.
        // Evict from the tail until reinsertion stays within both hard
        // bounds; the stream cursor is not advanced for anything dropped.
        while (
          eventBufferRef.current.length > 0 &&
          (eventBufferRef.current.length + eventsToStore.length >
            MAX_BUFFER_EVENTS ||
            eventBufferBytesRef.current + batchBytes > MAX_BUFFER_BYTES)
        ) {
          const dropped = eventBufferRef.current.pop();
          if (dropped) {
            eventBufferBytesRef.current = Math.max(
              0,
              eventBufferBytesRef.current - estimateEventBytes(dropped)
            );
          }
        }
        eventBufferRef.current.unshift(...eventsToStore);
        eventBufferBytesRef.current += batchBytes;
      }
    }

    // If more events in buffer, schedule another flush
    if (sessionIdRef.current === sid && eventBufferRef.current.length > 0) {
      flushTimerRef.current = setTimeout(flushBuffer, BUFFER_FLUSH_INTERVAL);
    }
  }, [debug]);

  /**
   * Process incoming WebSocket event
   */
  const processEvent = useCallback(
    (event: HostedKeyActivityEvent) => {
      const sid = sessionIdRef.current;
      if (!sid) return;

      // Skip if event_id is not newer than cursor.
      // Read from cursorRef (not the `cursor` state) so this callback is
      // stable — recreating it on every cursor update would make any
      // WebSocket handler holding a stale reference deduplicate against an
      // old cursor value, potentially re-processing already-consumed events.
      if (
        event.event_id &&
        compareStreamIds(event.event_id, cursorRef.current) <= 0
      ) {
        if (debug) {
          // Debug: skipping old event
        }
        return;
      }

      // Decide ONCE whether this event is a phantom thinking end marker.
      // If yes, drop it on the floor: do not push to buffer, do not
      // dispatch to the UI. Without this guard the buffered/persisted
      // history accumulates events that the UI deliberately filters out,
      // and on next replay the server-side activity log shows extra
      // entries the user never saw.
      if (isEmptyThinkingEndFrame(event)) {
        return;
      }

      const eventBytes = estimateEventBytes(event);
      if (
        wouldOverflowBuffer(
          eventBufferRef.current.length,
          eventBufferBytesRef.current,
          eventBytes
        )
      ) {
        if (!overflowWarnedRef.current) {
          overflowWarnedRef.current = true;
          log.warn(
            `[CloudActivitySync] Buffer limit reached (${MAX_BUFFER_EVENTS} events / ${MAX_BUFFER_BYTES} bytes); dropping newest events until persistence recovers`
          );
        }
        return;
      }

      // Add to the bounded buffer.
      eventBufferRef.current.push(event);
      eventBufferBytesRef.current += eventBytes;

      // Convert to SessionEvent and notify
      if (onEventsReceivedRef.current) {
        const chunk = eventToChunk(event);
        if (chunk) {
          processChunksRust([chunk], sid)
            .then((sessionEvents) => {
              if (sessionIdRef.current !== sid) return;
              if (onEventsReceivedRef.current) {
                onEventsReceivedRef.current(sessionEvents);
              }
            })
            .catch((err) => {
              log.warn("[CloudActivitySync] processChunksRust failed:", err);
            });
        }
      }

      // Schedule flush if not already scheduled
      if (!flushTimerRef.current) {
        flushTimerRef.current = setTimeout(flushBuffer, BUFFER_FLUSH_INTERVAL);
      }
    },
    [debug, flushBuffer]
  );

  // ============================================
  // Cursor Management
  // ============================================

  /**
   * Refresh cursor from local storage
   *
   * Reads through `cursorRef.current` on every fallback rather than the
   * captured `cursor` state value. Without this, the callback's closed-
   * over `cursor` could be the previous session's cursor when a session
   * switch races a refresh — leaking a stale stream id into a fresh
   * deduplication window and potentially re-processing events.
   *
   * The callback itself is stabilized by removing `cursor` from its
   * dependency array; consumers that need the live cursor should call
   * `refreshCursor()` to get the latest value rather than reading the
   * cached state.
   */
  const refreshCursor = useCallback(async (): Promise<string> => {
    const sid = sessionIdRef.current;
    if (!sid) return "0";

    try {
      const response = await hostedKeyActivityApi.getHostedKeyCursor(sid);
      // Session may have switched while the cursor request was in flight.
      // Returning the cached ref (rather than the captured `cursor`
      // state) ensures the caller gets the cursor for the CURRENT session
      // when sessions are racing — not the cursor that was active at
      // call time.
      if (sessionIdRef.current !== sid) return cursorRef.current;

      if (response?.status === 0 && response.data) {
        const newCursor = response.data.cursor;
        cursorRef.current = newCursor;
        setCursor(newCursor);

        if (debug) {
          // Debug: cursor refreshed
        }

        return newCursor;
      }
    } catch (err) {
      log.error("[CloudActivitySync] Failed to refresh cursor:", err);
    }

    return cursorRef.current;
  }, [debug]);

  // ============================================
  // History Loading
  // ============================================

  /**
   * Load historical activity from local storage
   */
  const loadHistory = useCallback(async (): Promise<SessionEvent[]> => {
    const sid = sessionIdRef.current;
    if (!sid) return [];
    // Note: this function may throw on network errors — callers must handle
    // the rejection. It does NOT silently return [] on failure.

    setIsLoadingHistory(true);
    setError(null);

    try {
      const cursorResponse = await hostedKeyActivityApi.getHostedKeyCursor(sid);
      if (sessionIdRef.current !== sid) return [];

      if (cursorResponse?.status === 0 && cursorResponse.data) {
        setCursor(cursorResponse.data.cursor);
      }

      const activityResponse = await hostedKeyActivityApi.getHostedKeyActivity(
        sid,
        { limit: 200 }
      );
      if (sessionIdRef.current !== sid) return [];

      if (activityResponse?.status === 0 && activityResponse.data) {
        const { chunks } = activityResponse.data;

        const activityChunks: ActivityChunk[] = chunks.map((chunk) => ({
          chunk_id: chunk.chunk_id,
          action_type: chunk.action_type,
          function: chunk.function,
          args: chunk.args,
          result: chunk.result,
          created_at: chunk.created_at,
          thread_id: chunk.thread_id,
          process_id: chunk.process_id,
        }));

        const sessionEvents = await processChunksRust(activityChunks, sid);
        return sessionEvents;
      }
    } catch (err) {
      if (sessionIdRef.current !== sid) return [];
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("[CloudActivitySync] Failed to load history:", err);
      setError(errorMsg);
      // Re-throw so the call-site .catch() can distinguish a real network
      // failure from an empty history (both previously appeared as []).
      throw err;
    } finally {
      if (sessionIdRef.current === sid) {
        setIsLoadingHistory(false);
      }
    }
    // Unreachable: either returned early (session mismatch) or threw. Here to
    // satisfy TypeScript's control-flow analysis for the Promise<SessionEvent[]> return type.
    return [];
  }, []);

  /**
   * Load more historical activity (pagination)
   */
  const loadMoreHistory = useCallback(
    async (after?: string): Promise<SessionEvent[]> => {
      const sid = sessionIdRef.current;
      if (!sid) return [];

      try {
        const response = await hostedKeyActivityApi.getHostedKeyActivity(sid, {
          limit: 100,
          after,
        });
        if (sessionIdRef.current !== sid) return [];

        if (response?.status === 0 && response.data) {
          const activityChunks: ActivityChunk[] = response.data.chunks.map(
            (chunk) => ({
              chunk_id: chunk.chunk_id,
              action_type: chunk.action_type,
              function: chunk.function,
              args: chunk.args,
              result: chunk.result,
              created_at: chunk.created_at,
              thread_id: chunk.thread_id,
              process_id: chunk.process_id,
            })
          );
          return processChunksRust(activityChunks, sid);
        }
      } catch (err) {
        log.error("[CloudActivitySync] Failed to load more history:", err);
      }

      return [];
    },
    []
  );

  // ============================================
  // Initialization
  // ============================================

  useEffect(() => {
    if (!enabled || !sessionId) {
      // Disabled-state cleanup
      //
      // Previously this branch only flipped `isReady` / `initializedRef`
      // but did NOT clear `flushTimerRef` or drain `eventBufferRef`.  If
      // the user disabled the sync (or the session id became null) while
      // a flush was already scheduled, the pending timer would still
      // fire and call `flushBuffer()` — which read `sessionIdRef.current`
      // and either (a) silently dropped the buffer when the ref was null
      // or (b) reused a buffer from the previously-enabled run on top of
      // the next enable, mixing two sessions' events.
      //
      // The safe behavior is "cancel the timer and discard the buffer".
      // The buffer represents the still-pending UI dispatches for the
      // session we just disabled; they have no consumer once disabled.
      // The persistence layer has already accepted everything that was
      // flushed up to this point — what's in the buffer is at-most one
      // BUFFER_FLUSH_INTERVAL window of events, and those will be
      // re-fetched by `loadHistory` on the next enable.
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      eventBufferRef.current = [];
      eventBufferBytesRef.current = 0;
      overflowWarnedRef.current = false;
      setIsReady(false);
      initializedRef.current = null;
      return;
    }

    // Prevent duplicate initialization
    if (initializedRef.current === sessionId) {
      return;
    }
    initializedRef.current = sessionId;

    // Reset state
    cursorRef.current = "0";
    setCursor("0");
    setError(null);
    eventBufferRef.current = [];
    eventBufferBytesRef.current = 0;
    overflowWarnedRef.current = false;

    const initSessionId = sessionId;
    loadHistory()
      .then((events) => {
        if (sessionIdRef.current !== initSessionId) return;
        if (onHistoryLoadedRef.current && events.length > 0) {
          onHistoryLoadedRef.current(events);
        }
        // Only mark ready on a successful (possibly empty) history load so
        // that WebSocket consumption doesn't start against a partially-loaded
        // state after a network error.
        setIsReady(true);
      })
      .catch((err: unknown) => {
        if (sessionIdRef.current !== initSessionId) return;
        const msg = err instanceof Error ? err.message : String(err);
        log.error("[CloudActivitySync] Init loadHistory failed:", msg);
        setError(msg);
        // Do NOT setIsReady(true) — keep the sync paused so the caller can
        // retry or surface the error rather than processing events on top of
        // incomplete history.
      });

    // Cleanup on unmount or session change.
    // Capture the session id at cleanup time so the fire-and-forget flush
    // below does NOT accidentally write to a NEW session if sessionIdRef
    // was already updated before the async batch completes.
    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      // Only flush if there are buffered events AND we're still on the same
      // session.  Checking sessionIdRef.current === sessionId guards against
      // the case where cleanup fires after a session switch: in that state
      // sessionIdRef already points to the new session, and calling
      // flushBuffer() would store the old session's events under the new id.
      if (
        eventBufferRef.current.length > 0 &&
        sessionIdRef.current === sessionId
      ) {
        void flushBuffer();
      }
    };
  }, [sessionId, enabled, loadHistory, flushBuffer]);

  // ============================================
  // Return
  // ============================================

  return {
    cursor,
    isLoadingHistory,
    isReady,
    error,
    processEvent,
    flushBuffer,
    refreshCursor,
    loadMoreHistory,
  };
}

export { isEmptyThinkingEndFrame } from "./hostedKeyEventUtils";

export const hostedKeyActivityBufferTestApi = {
  wouldOverflow: wouldOverflowBuffer,
  limits: {
    events: MAX_BUFFER_EVENTS,
    bytes: MAX_BUFFER_BYTES,
    singleEventBytes: MAX_SINGLE_EVENT_BYTES,
  },
};

export default useHostedKeyActivitySync;
