import { isBackendUserMessageEvent } from "@src/engines/SessionCore/sync/utils/activityIds";

import type { SessionEvent } from "../types";

export function inferSessionId(events: SessionEvent[]): string | null {
  if (events.length === 0) return null;
  const firstSessionId = events[0]?.sessionId;
  if (!firstSessionId) return null;
  return events.every((event) => event.sessionId === firstSessionId)
    ? firstSessionId
    : null;
}

export function isRealUserEvent(event: SessionEvent): boolean {
  return isBackendUserMessageEvent(event);
}

export interface SyntheticEvictionScope {
  matchingContents: string[];
  olderThan?: string;
}

/**
 * Scope for evicting synthetic user placeholders when a batch carrying real
 * backend user messages arrives: placeholders echoed by one of these
 * contents, or predating the newest real user turn, are safe to remove. A
 * newer unmatched placeholder is a just-sent message whose echo has not
 * arrived (e.g. right after an abort, when history replays are stale) and
 * must survive.
 */
export function syntheticEvictionScopeForRealUserEvents(
  events: SessionEvent[]
): SyntheticEvictionScope | null {
  const contents = new Set<string>();
  let olderThan: string | undefined;
  for (const event of events) {
    if (!isRealUserEvent(event)) continue;
    if (event.displayText) contents.add(event.displayText);
    const message = event.result?.message;
    if (
      typeof message === "object" &&
      message !== null &&
      "content" in message
    ) {
      const content = String(message.content ?? "");
      if (content) contents.add(content);
    }
    if (event.createdAt && (!olderThan || event.createdAt > olderThan)) {
      olderThan = event.createdAt;
    }
  }
  if (contents.size === 0 && !olderThan) return null;
  return { matchingContents: [...contents], olderThan };
}
