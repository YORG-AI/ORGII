/**
 * Canonical full-history read for a managed local session.
 *
 * Most runtimes persist normalized events in EventStore. External CLI
 * sessions can instead keep their transcript exclusively in the provider's
 * native store, so an empty EventStore is not proof of an empty transcript.
 * Keep that distinction here so cloud sync, background continuation, and
 * future consumers cannot accidentally publish a hollow CLI session.
 */
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isCliSession } from "@src/util/session/sessionDispatch";

import { loadCliHistory } from "./adapters/cli/cliHistory";

export interface AuthoritativeSessionEvents {
  events: SessionEvent[];
  /** Stable EventStore revision when EventStore was the authoritative source. */
  localContentRevision?: number;
  source: "event_store" | "cli_history";
}

export async function loadAuthoritativeSessionEvents(
  sessionId: string,
  signal: AbortSignal = new AbortController().signal
): Promise<AuthoritativeSessionEvents> {
  // CLI adapters own both of their durable transcript modes: legacy chunks
  // and provider-native stores. EventStore can contain only an optimistic
  // user row while the native transcript already contains the completed
  // assistant tail, so "persisted is non-empty" is not an authority test.
  if (isCliSession(sessionId)) {
    return {
      events: await loadCliHistory(sessionId, signal),
      source: "cli_history",
    };
  }

  const revisionBefore =
    await eventStoreProxy.getPersistedEventRevision(sessionId);
  const persisted = await eventStoreProxy.getPersistedEvents(sessionId);
  const revisionAfter =
    await eventStoreProxy.getPersistedEventRevision(sessionId);
  const localContentRevision =
    revisionBefore &&
    revisionAfter &&
    revisionBefore.revision === revisionAfter.revision &&
    revisionAfter.eventCount === persisted.length
      ? revisionAfter.revision
      : undefined;

  return {
    events: persisted,
    localContentRevision,
    source: "event_store",
  };
}
