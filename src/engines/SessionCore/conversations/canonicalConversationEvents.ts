/**
 * Canonical conversation read for runtime transfer.
 *
 * Provider-native history remains the round-trip verification authority. A
 * CLI can nevertheless be killed before its newest fork flushes; EventStore
 * then owns the already-accepted user row and durable partial output. Merge
 * only that provider-portable semantic suffix for continuation purposes.
 */
import { rpc } from "@src/api/tauri/rpc";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isInterruptedCliTerminalStatus } from "@src/engines/SessionCore/sync/adapters/cli/cliLifecycle";
import {
  type AuthoritativeSessionEvents,
  loadAuthoritativeSessionEvents,
} from "@src/engines/SessionCore/sync/authoritativeSessionEvents";
import { isCliSession } from "@src/util/session/sessionDispatch";

import { mergeInterruptedConversationProjection } from "./nativeConversationMaterializer";

export async function loadCanonicalConversationEvents(
  sessionId: string,
  signal: AbortSignal = new AbortController().signal
): Promise<AuthoritativeSessionEvents> {
  let authoritative: AuthoritativeSessionEvents;
  try {
    authoritative = await loadAuthoritativeSessionEvents(sessionId, signal);
  } catch (error) {
    if (!isCliSession(sessionId) || signal.aborted) throw error;

    const status = await rpc.cli.status({ sessionId }).catch(() => null);
    if (!isInterruptedCliTerminalStatus(status?.status)) throw error;

    // A killed CLI can leave its accepted user message and completed tool
    // output in EventStore without ever flushing a readable native file.
    // Recover only that existing portable projection; live/completed Sessions
    // still require the provider-native transcript above.
    const projected = await eventStoreProxy.getPersistedEvents(sessionId);
    return {
      events: mergeInterruptedConversationProjection([], projected),
      source: "cli_history",
    };
  }
  if (!isCliSession(sessionId) || signal.aborted) return authoritative;
  // Completed native turns have already flushed their provider transcript and
  // should stay on the cheap native-only path, especially for large Sessions.
  // Only a killed/failed turn can own a durable EventStore suffix that is not
  // yet present in the provider file.
  const status = await rpc.cli.status({ sessionId }).catch(() => null);
  if (!isInterruptedCliTerminalStatus(status?.status)) {
    return authoritative;
  }
  const projected = await eventStoreProxy
    .getPersistedEvents(sessionId)
    .catch(() => [] as SessionEvent[]);
  return {
    ...authoritative,
    events: mergeInterruptedConversationProjection(
      authoritative.events,
      projected
    ),
  };
}
