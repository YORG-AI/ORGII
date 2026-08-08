/**
 * Placeholder-first opens for cloud replays (0012 session turn index).
 *
 * While a teammate replay's segments stream into the local cache, the
 * owner-published turn index lets the Chat Pane render the ENTIRE round
 * skeleton immediately: one synthetic user-header event (the round prompt)
 * plus one unloaded-turn placeholder per round — the exact event shapes
 * Rust's `load_initial_turn_window_events` builds from the local turn index
 * once the download finalizes (turn_window.rs: `make_turn_user_header_event`
 * / `make_turn_placeholder_event`). Because the shapes and ids match, the
 * post-download hydration replaces this skeleton seamlessly.
 *
 * Everything here is in-memory only: turn placeholders and synthetic
 * headers are `is_synthetic_persistence_artifact`s in Rust and are filtered
 * from every cache write, so the skeleton can never pollute SQLite.
 */
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { namespaceCopyEventId } from "@src/features/TeamCollaboration/copyEventId";
import { createLogger } from "@src/hooks/logger";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import {
  type CloudSessionTurnSummary,
  getSessionTurnIndex,
} from "./org2CloudSyncClient";

const log = createLogger("cloudSessionTurnSkeleton");

/** Mirror of Rust `make_turn_user_header_event` (turn_window.rs). */
function makeTurnUserHeaderEvent(
  localSessionId: string,
  localTurnId: string,
  turn: CloudSessionTurnSummary,
  createdAt: string
): SessionEvent {
  const displayText = turn.prompt;
  return {
    id: localTurnId,
    chunk_id: localTurnId,
    sessionId: localSessionId,
    createdAt,
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: {
      syntheticTurnHeader: true,
      type: "user",
      message: {
        content: displayText,
        role: "user",
      },
    },
    source: "user",
    displayText,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
  };
}

/** Mirror of Rust `make_turn_placeholder_event` (turn_window.rs). */
function makeTurnPlaceholderEvent(
  localSessionId: string,
  localTurnId: string,
  localNextTurnId: string | null,
  turn: CloudSessionTurnSummary,
  startedAt: string
): SessionEvent {
  const eventCount = Math.max(0, turn.bodyEventCount);
  const placeholderId = `turn-placeholder-${localTurnId}`;
  return {
    id: placeholderId,
    chunk_id: placeholderId,
    sessionId: localSessionId,
    createdAt: turn.endedAt ?? startedAt,
    functionName: "turn_placeholder",
    uiCanonical: "turn_placeholder",
    actionType: "turn_placeholder",
    args: {},
    result: {
      unloadedTurn: {
        turnId: localTurnId,
        eventCount,
        bodyEventCount: eventCount,
        durationMs: Math.max(0, turn.durationMs ?? 0),
        startedAt,
        endedAt: turn.endedAt ?? null,
        nextTurnId: localNextTurnId,
      },
    },
    source: "assistant",
    displayText: `Turn ${localTurnId} is not loaded yet.`,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
  };
}

export function buildCloudTurnSkeletonEvents(
  localSessionId: string,
  turns: readonly CloudSessionTurnSummary[]
): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const turn of turns) {
    // The index carries SOURCE event ids; the local copy's id space is
    // namespaced (copyEventId.ts), and matching ids are what lets the
    // post-download hydration replace this skeleton in place.
    const localTurnId = namespaceCopyEventId(localSessionId, turn.turnId);
    const localNextTurnId = turn.nextTurnId
      ? namespaceCopyEventId(localSessionId, turn.nextTurnId)
      : null;
    const startedAt = turn.startedAt ?? turn.endedAt ?? "";
    events.push(
      makeTurnUserHeaderEvent(localSessionId, localTurnId, turn, startedAt)
    );
    // Zero-body rounds get no placeholder: the projection hides the expand
    // bar for bodyEventCount < 1, so it would be dead UI (same filter as
    // Rust's initial window).
    if (turn.bodyEventCount > 0) {
      events.push(
        makeTurnPlaceholderEvent(
          localSessionId,
          localTurnId,
          localNextTurnId,
          turn,
          startedAt
        )
      );
    }
  }
  // Same ordering contract as load_initial_turn_window_events.
  events.sort((left, right) =>
    left.createdAt === right.createdAt
      ? left.id.localeCompare(right.id)
      : left.createdAt.localeCompare(right.createdAt)
  );
  return events;
}

export interface ApplyCloudTurnSkeletonParams {
  accessToken: string;
  orgId: string;
  remoteSession: RemoteTeammateSessionMetadata;
  localSessionId: string;
  signal?: AbortSignal;
  /**
   * Checked immediately before the store write: the streamed import may
   * have finished (and hydrated the REAL initial window) while the index
   * fetch was in flight — applying after that would shadow real events.
   */
  shouldApply: () => boolean;
}

/**
 * Fetch the owner-published turn index and render the round skeleton into
 * the in-memory store. Best-effort progressive enhancement: every failure
 * or absence resolves false and the plain download UX stands.
 */
export async function applyCloudTurnSkeleton(
  params: ApplyCloudTurnSkeletonParams
): Promise<boolean> {
  try {
    const index = await getSessionTurnIndex(
      params.accessToken,
      params.orgId,
      params.remoteSession.sourceSessionId,
      params.signal !== undefined ? { signal: params.signal } : undefined
    );
    if (!index.turns || index.turns.length === 0) return false;
    // A stale index (written for another epoch than the listing advertises)
    // would draw rounds from a different timeline than the download.
    if (
      index.epoch !== null &&
      params.remoteSession.eventsEpoch !== undefined &&
      index.epoch !== params.remoteSession.eventsEpoch
    ) {
      return false;
    }
    const events = buildCloudTurnSkeletonEvents(
      params.localSessionId,
      index.turns
    );
    if (events.length === 0) return false;
    if (params.signal?.aborted || !params.shouldApply()) return false;
    await eventStoreProxy.set(events, params.localSessionId);
    if (!params.shouldApply()) {
      // The import finished while the skeleton write crossed the IPC
      // boundary — the placeholders just shadowed real events. Rehydrate
      // the real initial window from the finalized cache.
      await eventStoreProxy.loadInitialTurnWindow(params.localSessionId, 0);
      return false;
    }
    return true;
  } catch (error) {
    if (params.signal?.aborted) return false;
    log.warn("cloud turn skeleton unavailable; falling back to plain load", {
      localSessionId: params.localSessionId,
      error,
    });
    return false;
  }
}
