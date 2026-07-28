import { getImportedHistorySourceBySessionId } from "@src/api/tauri/externalHistory";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

export type RawTranscriptSource =
  | {
      kind: "external-history";
      sourceId: string;
      displayName: string;
    }
  | {
      kind: "orgii-event-store";
      displayName: string;
    };

export interface RawTranscriptSnapshot {
  sessionId: string;
  source: RawTranscriptSource;
  loadedAt: string;
  entries: unknown[];
}

export function mergeRawSessionEvents(
  persistedEvents: SessionEvent[],
  liveEvents: SessionEvent[],
  sessionId: string
): SessionEvent[] {
  const merged = new Map<string, SessionEvent>();
  for (const event of persistedEvents) {
    if (event.sessionId === sessionId) merged.set(event.id, event);
  }
  for (const event of liveEvents) {
    if (event.sessionId === sessionId) merged.set(event.id, event);
  }
  return Array.from(merged.values()).sort((left, right) => {
    const timeOrder = left.createdAt.localeCompare(right.createdAt);
    return timeOrder === 0 ? left.id.localeCompare(right.id) : timeOrder;
  });
}

export async function loadRawSessionTranscript(
  sessionId: string
): Promise<RawTranscriptSnapshot> {
  const externalSource = getImportedHistorySourceBySessionId(sessionId);
  if (externalSource) {
    const entries = await externalSource.loadFullTranscriptChunks(sessionId);
    return {
      sessionId,
      source: {
        kind: "external-history",
        sourceId: externalSource.sourceId,
        displayName: externalSource.displayName,
      },
      loadedAt: new Date().toISOString(),
      entries,
    };
  }

  const [persistedResult, liveResult] = await Promise.allSettled([
    eventStoreProxy.getPersistedEvents(sessionId),
    eventStoreProxy.getEvents(sessionId),
  ]);
  const persistedEvents =
    persistedResult.status === "fulfilled" ? persistedResult.value : [];
  const liveEvents = liveResult.status === "fulfilled" ? liveResult.value : [];
  if (
    persistedResult.status === "rejected" &&
    liveResult.status === "rejected"
  ) {
    throw persistedResult.reason;
  }

  return {
    sessionId,
    source: {
      kind: "orgii-event-store",
      displayName: "ORGII EventStore",
    },
    loadedAt: new Date().toISOString(),
    entries: mergeRawSessionEvents(persistedEvents, liveEvents, sessionId),
  };
}
