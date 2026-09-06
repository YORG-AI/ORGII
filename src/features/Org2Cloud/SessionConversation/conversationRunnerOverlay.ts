import { scopedNativeSourceEventIdOf } from "@src/engines/SessionCore/conversations/nativeConversationMaterializer";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { turnIntentIdOf } from "@src/engines/SessionCore/sync/utils/activityIds";

interface ConversationRunnerOverlay {
  runnerSessionId: string;
  turnId: string;
  eventStartIndex: number;
}

function runnerTurnIntentIdOf(event: SessionEvent): string | null {
  const value = (event.result as { turnIntentId?: unknown } | undefined)
    ?.turnIntentId;
  return typeof value === "string" && value.length > 0 ? value : null;
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
  events: readonly SessionEvent[]
): SessionEvent[] {
  // onSessionPreparing publishes this sentinel before native
  // materialization/synchronization has established a readable boundary.
  // Do not attempt prefix reconciliation until onSessionReady replaces it.
  if (runner.eventStartIndex === Number.MAX_SAFE_INTEGER) return [];
  // `eventStartIndex` belongs to the full provider transcript, while this
  // function consumes the filtered chat projection. Hidden provider rows make
  // those index spaces incomparable. The CLI runner stamps every live
  // projection with its already-durable turn intent at the single emit
  // boundary. Prefer that exact identity: semantic text matching can erase a
  // legitimate repeated answer, and numeric slicing can expose a freshly
  // materialized historical prefix.
  // Rust Agent persists an exact accepted user row but does not repeat the
  // durable intent on each assistant/tool row. Its existing turn boundary is
  // still exact: take only the contiguous non-user suffix until the next user,
  // excluding any explicitly materialized native-prefix projection.
  let acceptedUserIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.source === "user" && turnIntentIdOf(event) === runner.turnId) {
      acceptedUserIndex = index;
      break;
    }
  }
  if (acceptedUserIndex >= 0) {
    // Rust Agent already persists the accepted user row with the durable turn
    // intent, but its assistant/tool producer does not repeat that identity
    // on every row. That exact user boundary is safe: current writers mark
    // replayed native-prefix rows with their canonical source identity, and a
    // distinct turn intent always belongs to another turn. This preserves the
    // existing SDE path without falling back to text, timestamps, or the raw
    // provider index.
    const following = events.slice(acceptedUserIndex + 1);
    const nextUserIndex = following.findIndex(
      (event) => event.source === "user"
    );
    const currentTurnEnd =
      nextUserIndex >= 0
        ? acceptedUserIndex + 1 + nextUserIndex
        : events.length;
    return events.filter((event, index) => {
      if (event.source === "user") return false;
      const eventTurnIntentId = runnerTurnIntentIdOf(event);
      if (eventTurnIntentId === runner.turnId) return true;
      return (
        eventTurnIntentId === null &&
        index > acceptedUserIndex &&
        index < currentTurnEnd &&
        !scopedNativeSourceEventIdOf(event)
      );
    });
  }
  return events.filter(
    (event) =>
      event.source !== "user" && runnerTurnIntentIdOf(event) === runner.turnId
  );
}

export function buildConversationRunnerOverlay(
  runner: ConversationRunnerOverlay,
  events: readonly SessionEvent[],
  canonicalSessionId: string
): SessionEvent[] {
  return selectConversationRunnerTail(runner, events).map((event) => ({
    ...event,
    id: `runlive-${event.id}`,
    chunk_id: `runlive-${event.id}`,
    sessionId: canonicalSessionId,
  }));
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
