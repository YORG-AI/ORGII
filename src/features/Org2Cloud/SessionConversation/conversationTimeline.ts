/**
 * One conversation timeline: the local transcript with the 0024 plane folded
 * in by server seq.
 *
 * Every turn of a plane-backed conversation is on the plane — members' turns
 * through their runners, the owner's turns through the owner publisher — so
 * the plane's seq is the single total order every client agrees on. A local
 * event that ALSO lives on the plane (the owner's own transcript, a member's
 * imported replay copy of it) keeps its local identity and takes the plane's
 * position; local events that predate the plane keep the timestamp merge.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { CloudConversationEvent } from "../org2CloudConversationEventsClient";
import {
  CONVERSATION_SENDER_ARG,
  type ConversationSenderStamp,
  sourceEventIdOf,
} from "./continuationEvents";
import { buildConversationPlaneStreamEvents } from "./conversationPlaneEvents";

/**
 * Plane identity of an event. User rows match on the turn-intent id so the
 * optimistic synthetic row, the durable backend row and the pushed plane
 * row all collapse to one; everything else matches on the source event id
 * (import/fork copies peeled back to the original).
 */
export function conversationEventKey(event: SessionEvent): string {
  if (event.source === "user") {
    const intent = (event.result as { turnIntentId?: unknown } | undefined)
      ?.turnIntentId;
    if (typeof intent === "string" && intent.length > 0) {
      return `intent:${intent}`;
    }
  }
  return `event:${sourceEventIdOf(event)}`;
}

function timestampMs(value: string | undefined): number {
  const ms = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function stampSender(
  event: SessionEvent,
  row: CloudConversationEvent
): SessionEvent {
  const stamp: ConversationSenderStamp = {
    userId: row.authorUserId,
    displayName: row.authorDisplayName?.trim() || row.authorUserId,
  };
  return {
    ...event,
    args: { ...event.args, [CONVERSATION_SENDER_ARG]: stamp },
  };
}

/**
 * Fold plane rows (seq asc) into the local transcript.
 *
 * - A plane row whose twin exists locally renders the LOCAL event (stable
 *   ids, stable collapse state, the viewer's own rows stay editable) at the
 *   plane's position; other authors' user rows get the author stamp.
 * - A plane row without a twin renders as a namespaced plane row.
 * - Plane order is seq order, made monotone in time so a skewed sender
 *   clock can never reorder it; unclaimed local events (pre-plane history,
 *   the owner's still-running turn) interleave by timestamp.
 */
export function mergePlaneIntoTranscript(
  base: readonly SessionEvent[],
  rows: readonly CloudConversationEvent[],
  streamSessionId: string,
  viewerUserId?: string | null
): SessionEvent[] {
  if (rows.length === 0) return [...base];
  const twins = new Map<string, SessionEvent>();
  for (const event of base) {
    const key = conversationEventKey(event);
    if (!twins.has(key)) twins.set(key, event);
  }
  const planeStream = buildConversationPlaneStreamEvents(rows, streamSessionId);
  const claimed = new Set<SessionEvent>();
  const planeItems: { event: SessionEvent; ms: number }[] = [];
  let floorMs = 0;
  rows.forEach((row, index) => {
    const twin = twins.get(conversationEventKey(row.event));
    let event: SessionEvent;
    if (twin && !claimed.has(twin)) {
      claimed.add(twin);
      event =
        row.event.source === "user" && row.authorUserId !== viewerUserId
          ? stampSender(twin, row)
          : twin;
    } else {
      event = planeStream[index];
    }
    floorMs = Math.max(floorMs, timestampMs(event.createdAt));
    planeItems.push({ event, ms: floorMs });
  });
  const merged: SessionEvent[] = [];
  let cursor = 0;
  for (const event of base) {
    if (claimed.has(event)) continue;
    const eventMs = timestampMs(event.createdAt);
    while (cursor < planeItems.length && planeItems[cursor].ms < eventMs) {
      merged.push(planeItems[cursor].event);
      cursor += 1;
    }
    merged.push(event);
  }
  while (cursor < planeItems.length) {
    merged.push(planeItems[cursor].event);
    cursor += 1;
  }
  return merged;
}
