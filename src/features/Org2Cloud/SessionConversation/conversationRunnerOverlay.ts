import { removeKnownNativeConversationEchoes } from "@src/engines/SessionCore/conversations/nativeConversationMaterializer";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { turnIntentIdOf } from "@src/engines/SessionCore/sync/utils/activityIds";

interface ConversationRunnerOverlay {
  runnerSessionId: string;
  turnId: string;
  eventStartIndex: number;
}

export function collectLandedTurnIds(
  rows: readonly { turnId: string; event: Pick<SessionEvent, "source"> }[]
): Set<string> {
  const landed = new Set<string>();
  for (const row of rows) {
    if (row.event.source !== "user") landed.add(row.turnId);
  }
  return landed;
}

export function selectConversationRunnerTail(
  runner: ConversationRunnerOverlay,
  events: readonly SessionEvent[],
  knownCanonicalEvents: readonly SessionEvent[] = []
): SessionEvent[] {
  // `eventStartIndex` is captured from the complete provider transcript,
  // while this overlay consumes the ordinary chat projection. Hidden native
  // rows make those numeric indexes diverge. Prefer the accepted user intent,
  // which survives both projections.
  const intentIndex = events.findIndex(
    (event) => turnIntentIdOf(event) === runner.turnId
  );
  // Until the accepted row reaches the stream there is no safe projected
  // boundary. A fresh child already contains the materialized canonical
  // prefix, so numeric fallback can briefly replay that whole history.
  if (intentIndex < 0) return [];
  return removeKnownNativeConversationEchoes(
    knownCanonicalEvents,
    events.slice(intentIndex).filter((event) => event.source !== "user")
  );
}

export function buildConversationRunnerOverlay(
  runner: ConversationRunnerOverlay,
  events: readonly SessionEvent[],
  canonicalSessionId: string,
  knownCanonicalEvents: readonly SessionEvent[] = []
): SessionEvent[] {
  return selectConversationRunnerTail(runner, events, knownCanonicalEvents).map(
    (event) => ({
      ...event,
      id: `runlive-${event.id}`,
      chunk_id: `runlive-${event.id}`,
      sessionId: canonicalSessionId,
    })
  );
}

/** Avoid replacing the overlay when only an unrelated queue atom changed. */
export function conversationRunnerOverlaysEqual(
  left: readonly SessionEvent[] | undefined,
  right: readonly SessionEvent[]
): boolean {
  if (!left || left.length !== right.length) return false;
  return left.every((event, index) => {
    const candidate = right[index];
    return (
      event.id === candidate?.id &&
      event.displayStatus === candidate.displayStatus &&
      event.displayText === candidate.displayText &&
      event.isDelta === candidate.isDelta &&
      event.args === candidate.args &&
      event.result === candidate.result
    );
  });
}
