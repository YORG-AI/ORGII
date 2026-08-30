/**
 * useSessionEvents — subscribe to a specific session's events.
 *
 * Used by SubagentBlock / NestedActivityList to render child session
 * events as nested blocks. Subscription and primary hydration are owned
 * by `sessionSnapshotAtomFamily` (shared with session-scoped ChatHistory).
 * This hook adds Cursor IDE error surfacing and a retry loop for sessions
 * that mount before the first snapshot push arrives.
 */
import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  type SessionSnapshotState,
  extractSessionChatEvents,
  sessionSnapshotAtomFamily,
} from "@src/engines/SessionCore/derived/sessionScopedChatEvents";
import { ensureCursorIdeEventsInStore } from "@src/engines/SessionCore/sync/adapters/cursorIdeAdapter";
import { createLogger } from "@src/hooks/logger";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";

import type { SessionEvent } from "../types";
import {
  type Snapshot,
  eventStoreProxy,
  isStreamingSnapshot,
} from "./EventStoreProxy";
import { normalizeSessionEventsError } from "./sessionEventsError";

const log = createLogger("useSessionEvents");

interface SessionEventsState {
  events: SessionEvent[];
  loading: boolean;
  error: Error | null;
}

const EMPTY_STATE: SessionEventsState = {
  events: [],
  loading: false,
  error: null,
};

const EMPTY_SNAPSHOT_STATE: SessionSnapshotState = {
  snapshot: null,
  loadStarted: false,
};

const emptySnapshotStateAtom = atom<SessionSnapshotState>(EMPTY_SNAPSHOT_STATE);
emptySnapshotStateAtom.debugLabel = "session/emptySnapshotState";

const RETRY_INTERVALS = [150, 300, 600, 1200, 2000];

export function extractChatEvents(snapshot: Snapshot): SessionEvent[] {
  if (isStreamingSnapshot(snapshot)) {
    return snapshot.chatEvents;
  }
  return extractSessionChatEvents(snapshot);
}

export { normalizeSessionEventsError } from "./sessionEventsError";

export function useSessionEvents(
  sessionId: string | undefined
): SessionEventsState {
  const { snapshot, loadStarted } = useAtomValue(
    sessionId ? sessionSnapshotAtomFamily(sessionId) : emptySnapshotStateAtom
  );
  const events = useMemo(() => extractSessionChatEvents(snapshot), [snapshot]);

  const [error, setError] = useState<Error | null>(null);
  const [retryPending, setRetryPending] = useState(false);
  const hasEventsRef = useRef(false);
  hasEventsRef.current = events.length > 0;

  useEffect(() => {
    if (!sessionId) {
      setError(null);
      setRetryPending(false);
      return;
    }
    if (hasEventsRef.current) {
      setRetryPending(false);
      return;
    }

    let cancelled = false;
    setError(null);
    setRetryPending(true);

    async function waitForEvents() {
      try {
        if (isCursorIdeSession(sessionId!)) {
          await ensureCursorIdeEventsInStore(sessionId!);
          if (cancelled || hasEventsRef.current) return;
          await eventStoreProxy.loadFromCache(sessionId!);
          if (cancelled || hasEventsRef.current) return;
        }

        if (snapshot || hasEventsRef.current) return;

        for (const delay of RETRY_INTERVALS) {
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          if (cancelled || hasEventsRef.current) return;

          const retrySnap = await eventStoreProxy.getSnapshot(sessionId!);
          if (cancelled || hasEventsRef.current) return;
          if (retrySnap.chatEvents.length > 0) return;
        }

        if (!cancelled && !hasEventsRef.current) {
          await new Promise<void>((resolve) => setTimeout(resolve, 3000));
        }
      } catch (err) {
        if (!cancelled) {
          const normalizedErr = normalizeSessionEventsError(err);
          log.warn(
            `[useSessionEvents] Failed to load events for session=${sessionId}:`,
            normalizedErr
          );
          setError(normalizedErr);
        }
      } finally {
        if (!cancelled) setRetryPending(false);
      }
    }

    void waitForEvents();

    return () => {
      cancelled = true;
    };
  }, [sessionId, snapshot, loadStarted]);

  if (!sessionId) return EMPTY_STATE;

  const loading =
    events.length === 0 && error === null && (retryPending || !loadStarted);
  return { events, loading, error };
}
