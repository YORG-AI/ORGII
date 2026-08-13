import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { stripCopyEventNamespace } from "@src/features/TeamCollaboration/copyEventId";

type MessageIdentity = Pick<SessionEvent, "id" | "sessionId">;

/**
 * Imported and inherited shared-session events are namespaced when copied
 * into the local event store. Messages created by this local session keep
 * their native ids, including messages sent after taking over a shared
 * conversation.
 */
export function resolveUserMessageSide(
  event: MessageIdentity | undefined
): "left" | "right" {
  if (!event) return "right";
  return stripCopyEventNamespace(event.sessionId, event.id) === event.id
    ? "right"
    : "left";
}
