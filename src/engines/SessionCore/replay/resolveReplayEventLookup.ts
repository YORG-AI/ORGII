import {
  getPlanEventAliases,
  isPlanDisplayEvent,
  planAliasesContain,
} from "@src/engines/SessionCore/derived/planDisplayEvents";

import type { SessionEvent } from "../core/types";

/**
 * Resolve a chat/simulator navigation id to the canonical session event.
 * Mirrors the lookup rules in `useChatEventReplay` for remote surfaces that
 * do not mount the desktop EventStore.
 */
export function resolveReplayEventLookup(
  events: SessionEvent[],
  eventId: string
): SessionEvent | null {
  if (!eventId || events.length === 0) return null;

  let lookupId = eventId;
  if (eventId.startsWith("group:stageoutput:")) {
    const parts = eventId.split(":");
    if (parts.length >= 4) {
      lookupId = parts.slice(3).join(":");
    }
  }

  const byId = new Map<string, SessionEvent>();
  const chunkIdToEventId = new Map<string, string>();
  for (const event of events) {
    byId.set(event.id, event);
    const chunkId = event.chunk_id;
    if (typeof chunkId === "string" && chunkId.length > 0) {
      chunkIdToEventId.set(chunkId, event.id);
    }
  }

  let resolved = byId.get(lookupId) ?? null;
  if (!resolved) {
    const mappedId = chunkIdToEventId.get(lookupId);
    resolved = mappedId ? (byId.get(mappedId) ?? null) : null;
  }
  if (!resolved) {
    resolved =
      events.find((candidate) => {
        if (!isPlanDisplayEvent(candidate)) return false;
        return planAliasesContain(getPlanEventAliases(candidate), lookupId);
      }) ?? null;
  }

  return resolved;
}

export function resolveReplayEventIndex(
  events: SessionEvent[],
  eventId: string
): number {
  const event = resolveReplayEventLookup(events, eventId);
  if (!event) return -1;
  return events.findIndex((candidate) => candidate.id === event.id);
}
