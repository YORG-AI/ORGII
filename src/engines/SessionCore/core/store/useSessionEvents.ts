/**
 * useSessionEvents — subscribe to a specific session's events.
 *
 * Used by SubagentBlock / NestedActivityList to render child session
 * events as nested blocks. The hook:
 *
 * 1. Subscribes to `es:changed` for the session via `subscribeSession`
 * 2. For any bounded external replay session, pre-warms one capped replay
 *    window. Native agent sessions continue to use their SQLite cache.
 * 3. Lazy-loads events from Rust EventStore via `es_load_from_cache` +
 *    `es_get_snapshot`. If the session is already in memory (live subagent
 *    or freshly pre-warmed cursor history), `es_load_from_cache` triggers a
 *    `schedule_notify` on the Rust side so the subscription receives the
 *    current snapshot immediately.
 * 4. When the first pull returns empty (subagent just spawned, no events yet),
 *    keeps `loading: true` and polls with exponential back-off until the
 *    subscription delivers the first real snapshot or the session is unmounted.
 *
 * On unmount (collapse), the subscription is cleaned up. The Rust-side
 * EventStore retains the data until LRU eviction.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { resolveExternalReplayTarget } from "@src/api/tauri/externalHistory/replay";
import { ensureExternalReplayEventsInStore } from "@src/engines/SessionCore/sync/adapters/cursorIdeAdapter";
import { createLogger } from "@src/hooks/logger";
import { formatInvokeError } from "@src/util/formatInvokeError";

import type { SessionEvent } from "../types";
import {
  type DerivedSnapshot,
  type Snapshot,
  eventStoreProxy,
  isStreamingSnapshot,
} from "./EventStoreProxy";

const log = createLogger("useSessionEvents");

interface SessionEventsState {
  events: SessionEvent[];
  loading: boolean;
  /**
   * Non-null when the load path threw (Tauri unavailable, Cursor IDE
   * pre-warm failed, schema parse error, etc.). Consumers can show a
   * retry button or fall back to the empty state — the previous
   * implementation swallowed these silently which made
   * "subagent shows empty events forever" bugs invisible.
   *
   * `loading` returns to `false` when an error is surfaced so the
   * UI doesn't spin forever waiting on a request that has already
   * failed.
   */
  error: Error | null;
}

const EMPTY_STATE: SessionEventsState = {
  events: [],
  loading: false,
  error: null,
};

/** Retry intervals (ms) when the first pull returns an empty event list. */
const RETRY_INTERVALS = [150, 300, 600, 1200, 2000];

export function extractChatEvents(snapshot: Snapshot): SessionEvent[] {
  if (isStreamingSnapshot(snapshot)) {
    return snapshot.chatEvents;
  }
  return (snapshot as DerivedSnapshot).chatEvents;
}

/**
 * Normalise an arbitrary thrown value into a real `Error` so the
 * `error` field in {@link SessionEventsState} is uniform regardless
 * of whether the rejection came from Tauri, a Zod parse, or a raw
 * thrown string. Exported for tests.
 *
 * Resolution order, chosen so the rendered text matches every other
 * session-layer error site (`useQueueDispatch`, `useSessionSync`,
 * `SessionService`, …) while still being maximally informative:
 *
 * 1. Already an `Error` → returned as-is (prototype chain preserved).
 * 2. {@link formatInvokeError} extracts a `.message` / `.error` field
 *    from Tauri-style object rejections — the same extraction the rest
 *    of the codebase relies on, so a Tauri reject reads identically here.
 * 3. Otherwise fall back to `JSON.stringify` so a structured payload
 *    (`{ code, detail }`) is still legible instead of `"[object Object]"`.
 * 4. Circular refs / un-stringifiable values → `"unknown error"`.
 */
export function normalizeSessionEventsError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);

  const extracted = formatInvokeError(err);
  if (extracted !== "") return new Error(extracted);

  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error("unknown error");
  }
}

export function useSessionEvents(
  sessionId: string | undefined
): SessionEventsState {
  const [state, setState] = useState<SessionEventsState>({
    events: [],
    loading: Boolean(sessionId),
    error: null,
  });
  const loadedRef = useRef<string | null>(null);
  const resolvedByPushRef = useRef(false);

  const handleSnapshot = useCallback((snapshot: Snapshot) => {
    const chatEvents = extractChatEvents(snapshot);
    resolvedByPushRef.current = true;
    setState({ events: chatEvents, loading: false, error: null });
  }, []);

  const stableEmpty = useMemo(() => EMPTY_STATE, []);

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;
    resolvedByPushRef.current = false;

    const unsub = eventStoreProxy.subscribeSession(sessionId, handleSnapshot);

    async function load() {
      // When sessionId transitions from undefined → defined, the initial
      // useState value has loading: false. Set loading: true so the UI
      // shows a spinner while we fetch.
      setState((prev) =>
        prev.loading
          ? prev
          : { events: prev.events, loading: true, error: null }
      );
      // Re-check the proxy cache *after* subscribing to close the race
      // window where a snapshot arrived between render and subscription.
      const liveSnap = eventStoreProxy.getLatestSessionSnapshot(sessionId!);
      if (liveSnap) {
        const evts = extractChatEvents(liveSnap);
        loadedRef.current = sessionId!;
        if (!cancelled) {
          setState({ events: evts, loading: false, error: null });
        }
        return;
      }

      try {
        if (resolveExternalReplayTarget(sessionId!)) {
          await ensureExternalReplayEventsInStore(sessionId!);
        } else {
          await eventStoreProxy.loadFromCache(sessionId!);
        }
        if (cancelled) return;
        loadedRef.current = sessionId!;

        // Re-check proxy cache: loadFromCache triggers schedule_notify
        // which may have already delivered a snapshot to handleSnapshot
        // or stored it in _latestSnapshots.
        if (resolvedByPushRef.current) return;
        const postLoadSnap = eventStoreProxy.getLatestSessionSnapshot(
          sessionId!
        );
        if (postLoadSnap) {
          const evts = extractChatEvents(postLoadSnap);
          if (!cancelled) {
            setState({ events: evts, loading: false, error: null });
          }
          return;
        }

        const snap = await eventStoreProxy.getSnapshot(sessionId);
        if (cancelled) return;
        const evts = snap.chatEvents;

        if (evts.length > 0) {
          setState({ events: evts, loading: false, error: null });
          return;
        }

        for (const delay of RETRY_INTERVALS) {
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          if (cancelled || resolvedByPushRef.current) return;

          const retrySnap = await eventStoreProxy.getSnapshot(sessionId);
          if (cancelled || resolvedByPushRef.current) return;
          const retryEvts = retrySnap.chatEvents;
          if (retryEvts.length > 0) {
            setState({ events: retryEvts, loading: false, error: null });
            return;
          }
        }

        // Exhausted standard retries. For streaming subagents the first
        // es:changed can arrive later than 2s (LLM cold-start). Do one
        // more long-tail check before giving up.
        if (!cancelled && !resolvedByPushRef.current) {
          await new Promise<void>((resolve) => setTimeout(resolve, 3000));
          if (cancelled || resolvedByPushRef.current) return;
          const finalSnap = eventStoreProxy.getLatestSessionSnapshot(
            sessionId!
          );
          if (finalSnap) {
            const finalEvts = extractChatEvents(finalSnap);
            if (finalEvts.length > 0) {
              setState({
                events: finalEvts,
                loading: false,
                error: null,
              });
              return;
            }
          }
          setState((prev) => ({
            events: prev.events,
            loading: false,
            error: null,
          }));
        }
      } catch (err) {
        // Previous implementation swallowed the rejection silently
        // with `_err`. That hid a class of "subagent never renders"
        // bugs because the user only saw an empty block, never an
        // error. We now:
        //   1. Surface the error via the state (consumers can show a
        //      retry button or fall back).
        //   2. Log a warning so the failure is at least visible in
        //      the console during development.
        if (!cancelled) {
          const normalizedErr = normalizeSessionEventsError(err);
          log.warn(
            `[useSessionEvents] Failed to load events for session=${sessionId}:`,
            normalizedErr
          );
          setState((prev) => ({
            events: prev.events,
            loading: false,
            error: normalizedErr,
          }));
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
      unsub();
    };
  }, [sessionId, handleSnapshot]);

  if (!sessionId) return stableEmpty;
  return state;
}
