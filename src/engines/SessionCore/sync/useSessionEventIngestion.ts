import { useEffect } from "react";

import { parseRawSessionEvent } from "@src/engines/SessionCore/core/schemas";
import "@src/engines/SessionCore/sync/adapters";
import { getAdapterForSession } from "@src/engines/SessionCore/sync/types";
import { subscribeToSessionEvents } from "@src/engines/SessionCore/sync/useSessionChannel";

interface SharedSessionEventIngestion {
  disposeHandler: () => void;
  unsubscribeChannel: () => void;
  subscribers: number;
}

const sharedSessionEventIngestions = new Map<
  string,
  SharedSessionEventIngestion
>();

/**
 * Share the stateful adapter handler as well as the backend channel. Streaming
 * handlers accumulate deltas, so two handlers must not consume the same frame
 * and manufacture two temporary rows for one provider stream.
 */
export function subscribeToSessionEventIngestion(
  sessionId: string
): () => void {
  let shared = sharedSessionEventIngestions.get(sessionId);
  if (!shared) {
    const adapter = getAdapterForSession(sessionId);
    if (!adapter) return () => undefined;
    const handler = adapter.createEventHandler(sessionId, {});
    const unsubscribeChannel = subscribeToSessionEvents(sessionId, (raw) => {
      handler.handleEvent(parseRawSessionEvent(raw));
    });
    shared = {
      disposeHandler: () => handler.dispose(),
      unsubscribeChannel,
      subscribers: 0,
    };
    sharedSessionEventIngestions.set(sessionId, shared);
  }
  shared.subscribers += 1;

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = sharedSessionEventIngestions.get(sessionId);
    if (!current) return;
    current.subscribers -= 1;
    if (current.subscribers > 0) return;
    sharedSessionEventIngestions.delete(sessionId);
    current.unsubscribeChannel();
    current.disposeHandler();
  };
}

/**
 * Feed one session's existing adapter from its shared backend IPC channel.
 *
 * Visible SessionCore surfaces already mount this edge through useSessionSync.
 * Hidden executions (group members and canonical-conversation runners) use
 * this hook so their live frames reach the same EventStore ingestion owner.
 */
export function useSessionEventIngestion(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId) return;
    return subscribeToSessionEventIngestion(sessionId);
  }, [sessionId]);
}
