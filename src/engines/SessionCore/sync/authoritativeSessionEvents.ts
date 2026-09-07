/**
 * Canonical full-history read for one managed or imported local Session.
 *
 * Rust-native, managed CLI, and read-only external-history sessions are read
 * through their established native-history adapters. EventStore is a
 * render/cache projection and can be empty immediately after a transcript is
 * seeded, so it cannot prove that a provider-native materialization
 * round-tripped.
 */
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  isCliSession,
  isCollaborationImportedSession,
} from "@src/util/session/sessionDispatch";

import { loadCliHistory } from "./adapters/cli/cliHistory";
import { getAdapterForSession } from "./types";

export interface AuthoritativeSessionEvents {
  events: SessionEvent[];
  source:
    | "agent_history"
    | "cli_history"
    | "external_history"
    | "collaboration_replay";
}

export async function loadAuthoritativeSessionEvents(
  sessionId: string,
  signal: AbortSignal = new AbortController().signal
): Promise<AuthoritativeSessionEvents> {
  if (isCliSession(sessionId)) {
    return {
      events: await loadCliHistory(sessionId, signal),
      source: "cli_history",
    };
  }

  if (isCollaborationImportedSession(sessionId)) {
    return {
      // A collaboration import is already the complete, cursor-verified Cloud
      // replay persisted by collabSessionImport. It is deliberately not a
      // provider external-history session and therefore has no native adapter.
      events: await eventStoreProxy.getPersistedEvents(sessionId),
      source: "collaboration_replay",
    };
  }

  const adapter = getAdapterForSession(sessionId);
  if (
    !adapter ||
    (adapter.category !== "agent" && adapter.category !== "external_history")
  ) {
    throw new Error(
      `No authoritative native history reader is registered for ${sessionId}`
    );
  }
  if (
    adapter.category === "external_history" &&
    !adapter.loadAuthoritativeHistory
  ) {
    throw new Error(
      `No authoritative full-history reader is registered for ${sessionId}`
    );
  }
  const events =
    adapter.category === "external_history"
      ? await adapter.loadAuthoritativeHistory!(sessionId, signal)
      : await adapter.loadHistory(sessionId, signal);
  return {
    events,
    source:
      adapter.category === "external_history"
        ? "external_history"
        : "agent_history",
  };
}
