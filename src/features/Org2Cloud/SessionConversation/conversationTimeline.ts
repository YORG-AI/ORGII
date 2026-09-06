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
import {
  CONVERSATION_SENDER_ARG,
  CONVERSATION_VIEWER_LOADING,
  type ConversationSenderStamp,
  type ConversationViewerState,
} from "@src/engines/SessionCore/conversations/conversationSenderMetadata";
import { CONVERSATION_TURN_ID_ARG } from "@src/engines/SessionCore/conversations/localConversationContinuation";
import { nativeConversationEventSemanticKey } from "@src/engines/SessionCore/conversations/nativeConversationMaterializer";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { CloudConversationEvent } from "../org2CloudConversationEventsClient";
import {
  collapseConversationSourceCopies,
  materializedConversationTurnIdOf,
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
    const materializedIntent = materializedConversationTurnIdOf(event);
    if (materializedIntent) return `intent:${materializedIntent}`;
  }
  return `event:${sourceEventIdOf(event)}`;
}

function timestampMs(value: string | undefined): number {
  const ms = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function stampPlaneMetadata(
  event: SessionEvent,
  row: CloudConversationEvent,
  includeSender: boolean
): SessionEvent {
  const stamp: ConversationSenderStamp = {
    userId: row.authorUserId,
    ...(row.authorDisplayName?.trim()
      ? { displayName: row.authorDisplayName.trim() }
      : {}),
    ...(row.authorAvatarUrl ? { avatarUrl: row.authorAvatarUrl } : {}),
  };
  return {
    ...event,
    args: {
      ...event.args,
      ...(includeSender ? { [CONVERSATION_SENDER_ARG]: stamp } : {}),
      [CONVERSATION_TURN_ID_ARG]: row.turnId,
    },
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
  viewer: ConversationViewerState = CONVERSATION_VIEWER_LOADING
): SessionEvent[] {
  if (rows.length === 0) return [...base];
  // A provider-native owner can fold a plane turn into its own transcript and
  // later publish that Session replay. Imports then contain both the original
  // plane identity and a namespaced native echo of it. Collapse those copies
  // before matching plane rows; repeated equal text with distinct source ids
  // remains distinct.
  const uniqueBase: SessionEvent[] = [];
  const seenBaseKeys = new Set<string>();
  for (const event of base) {
    const key = conversationEventKey(event);
    if (seenBaseKeys.has(key)) continue;
    seenBaseKeys.add(key);
    uniqueBase.push(event);
  }
  const twins = new Map<string, SessionEvent>();
  const semanticTwins = new Map<string, SessionEvent[]>();
  for (const event of uniqueBase) {
    const key = conversationEventKey(event);
    if (!twins.has(key)) twins.set(key, event);
    const semanticKey = nativeConversationEventSemanticKey(event);
    if (semanticKey) {
      const candidates = semanticTwins.get(semanticKey) ?? [];
      candidates.push(event);
      semanticTwins.set(semanticKey, candidates);
    }
  }
  const planeStream = buildConversationPlaneStreamEvents(rows, streamSessionId);
  const claimed = new Set<SessionEvent>();
  const planeItems: { event: SessionEvent; ms: number }[] = [];
  const seenPlaneKeys = new Set<string>();
  let floorMs = 0;
  rows.forEach((row, index) => {
    const key = conversationEventKey(row.event);
    // The plane is idempotent per wire row, while an older client may still
    // have republished a materialized echo under a new row id. Source identity
    // is the canonical idempotency boundary for rendering and rematerializing.
    if (seenPlaneKeys.has(key)) return;
    seenPlaneKeys.add(key);
    let twin = twins.get(key);
    if (!twin || claimed.has(twin)) {
      const semanticKey = nativeConversationEventSemanticKey(row.event);
      twin = semanticKey
        ? semanticTwins
            .get(semanticKey)
            ?.find((candidate) => !claimed.has(candidate))
        : undefined;
    }
    let event: SessionEvent;
    if (twin && !claimed.has(twin)) {
      claimed.add(twin);
      event =
        row.event.source === "user" &&
        viewer.status !== "loading" &&
        (viewer.status === "signed_out" || row.authorUserId !== viewer.userId)
          ? stampPlaneMetadata(twin, row, true)
          : twin;
    } else {
      event = planeStream[index];
    }
    floorMs = Math.max(floorMs, timestampMs(event.createdAt));
    planeItems.push({ event, ms: floorMs });
  });
  const merged: SessionEvent[] = [];
  let cursor = 0;
  for (const event of uniqueBase) {
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
  // User rows normally match by turn intent so optimistic/backend/plane
  // lifecycle copies retain one visible bubble. A native replay can preserve
  // the same globally scoped source event under a different turn intent,
  // though; in that case intent matching alone admits the same canonical item
  // twice. The source boundary is the final idempotency owner. It compares no
  // content, so genuinely repeated messages with distinct source ids survive.
  return collapseConversationSourceCopies(merged);
}
