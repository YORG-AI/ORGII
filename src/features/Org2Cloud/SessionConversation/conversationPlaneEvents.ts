import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { CloudConversationEvent } from "../org2CloudConversationEventsClient";
import {
  CONVERSATION_SENDER_ARG,
  type ConversationSenderStamp,
} from "./continuationEvents";

const PLANE_ID_PREFIX = "convplane-";

/**
 * Synthesize stream rows from 0024 conversation-plane events. The payload
 * already IS a normalized SessionEvent — synthesis only namespaces the id
 * (plane rows must never collide with locally persisted events) and stamps
 * user rows with the author so attribution renders account-based, exactly
 * like stitched fork segments did.
 */
export function buildConversationPlaneStreamEvents(
  rows: readonly CloudConversationEvent[],
  streamSessionId: string
): SessionEvent[] {
  return rows.map((row) => {
    const inner = row.event;
    const stamp: ConversationSenderStamp = {
      userId: row.authorUserId,
      displayName: row.authorDisplayName?.trim() || row.authorUserId,
    };
    const stamped: SessionEvent = {
      ...inner,
      id: `${PLANE_ID_PREFIX}${row.id}`,
      chunk_id: `${PLANE_ID_PREFIX}${row.id}`,
      sessionId: streamSessionId,
      createdAt: inner.createdAt || row.createdAt,
      args:
        inner.source === "user"
          ? { ...inner.args, [CONVERSATION_SENDER_ARG]: stamp }
          : inner.args,
    };
    return stamped;
  });
}
