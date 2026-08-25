/**
 * Owner publisher — the owner's half of "every turn is on the plane".
 *
 * A member's turn reaches the plane through its local continuation; the
 * owner's turn runs in the owner's own session and used to reach other
 * clients only through the session replay (slow, and ordered by sender
 * clock against the plane). This publishes the owner's turn to the plane
 * under a turnId exactly like a member turn — the user row as soon as the
 * dispatch persisted it, the agent tail at the turn's terminal — so the
 * plane's seq is the one order for every turn of the conversation.
 *
 * The pushed user row reuses the local synthetic event's id and
 * turn-intent id; the pushed tail reuses the local event ids. That is what
 * lets every client fold the plane rows onto their local twins instead of
 * rendering a second copy.
 */
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { extractChatEvents } from "@src/engines/SessionCore/core/store/useSessionEvents";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { waitForTurnIntentOutcome } from "@src/engines/SessionCore/services/TurnDispatchService";
import { createLogger } from "@src/hooks/logger";

import {
  boundConversationEventForPush,
  pushConversationEventsChunked,
} from "../org2CloudConversationEventsClient";
import { advanceStoredOwnerPlaneCursor } from "./conversationExecutionStore";
import {
  buildConversationPlaneUserEvent,
  findUserEventByIntent,
  sliceTurnTailByIntent,
  turnIntentIdOf,
} from "./conversationTurnEvents";

const log = createLogger("ConversationOwnerPublisher");

const TURN_DEADLINE_MS = 15 * 60_000;

export { findUserEventByIntent };

/**
 * The clean user row for the plane: the user's visible words only (the
 * agent copy may carry the injected conversation context), under the local
 * event's id and turn-intent id so it folds onto the local row everywhere.
 */
export function buildOwnerUserRow(
  userEvent: SessionEvent,
  displayText: string
): SessionEvent {
  const turnIntentId = turnIntentIdOf(userEvent);
  if (!turnIntentId) {
    throw new Error("owner user row is missing its turn intent");
  }
  return buildConversationPlaneUserEvent({
    id: userEvent.id,
    createdAt: userEvent.createdAt,
    displayText,
    turnIntentId,
  });
}

/**
 * The agent tail of one turn: every non-user event after the turn's user
 * row, up to the next turn's user row. `null` when the user row is not in
 * the transcript (the dispatch failed and removed it).
 */
export const sliceOwnerTurnTail = sliceTurnTailByIntent;

function waitForUserEvent(
  sessionId: string,
  turnIntentId: string,
  deadlineMs: number
): Promise<SessionEvent> {
  const cached = eventStoreProxy.getLatestSessionSnapshot(sessionId);
  const immediate = cached
    ? findUserEventByIntent(extractChatEvents(cached), turnIntentId)
    : null;
  if (immediate) return Promise.resolve(immediate);
  return new Promise<SessionEvent>((resolve, reject) => {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      reject(new Error("owner turn user row never persisted"));
      return;
    }
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error("owner turn user row never persisted"));
    }, remainingMs);
    unsubscribe = eventStoreProxy.subscribeSession(sessionId, (snapshot) => {
      const found = findUserEventByIntent(
        extractChatEvents(snapshot),
        turnIntentId
      );
      if (!found) return;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(found);
    });
  });
}

export interface PublishOwnerTurnParams {
  /** Resolved before every push — a long turn outlives a captured token. */
  getAccessToken: () => Promise<string>;
  orgId: string;
  rootSessionId: string;
  /** The owner's own session — the conversation root. */
  sessionId: string;
  /** The intent id the dispatch was minted with; keys the local user row. */
  turnIntentId: string;
  displayText: string;
  executorScope: string;
  /** Provider-neutral local persistence identity; not the Cloud transport id. */
  executionRootKey: string;
  /** Plane head fetched and injected immediately before this dispatch. */
  readThroughPlaneSeq: number;
  /** Fires after each successful push (signal-bump hook). */
  onPushed?: () => void;
}

export interface PublishOwnerTurnResult {
  turnId: string;
  pushedEventCount: number;
}

export async function publishOwnerTurn(
  params: PublishOwnerTurnParams
): Promise<PublishOwnerTurnResult> {
  const deadlineMs = Date.now() + TURN_DEADLINE_MS;
  const turnId = params.turnIntentId;
  const userEvent = await waitForUserEvent(
    params.sessionId,
    params.turnIntentId,
    deadlineMs
  );
  await pushConversationEventsChunked(await params.getAccessToken(), {
    orgId: params.orgId,
    rootSessionId: params.rootSessionId,
    turnId,
    events: [
      boundConversationEventForPush(
        buildOwnerUserRow(userEvent, params.displayText)
      ),
    ],
  });
  params.onPushed?.();

  const outcome = await waitForTurnIntentOutcome(
    params.turnIntentId,
    deadlineMs
  );
  if (outcome.status === "completed") {
    advanceStoredOwnerPlaneCursor(
      params.executorScope,
      params.executionRootKey,
      params.readThroughPlaneSeq
    );
  }
  const persisted = await eventStoreProxy
    .getPersistedEvents(params.sessionId)
    .catch(() => [] as SessionEvent[]);
  const tail = sliceTurnTailByIntent(persisted, params.turnIntentId) ?? [];
  if (tail.length > 0) {
    await pushConversationEventsChunked(await params.getAccessToken(), {
      orgId: params.orgId,
      rootSessionId: params.rootSessionId,
      turnId,
      events: tail.map(boundConversationEventForPush),
    });
    params.onPushed?.();
  }
  log.info(
    `published owner turn ${turnId}: 1 + ${tail.length} event(s) to ${params.orgId}:${params.rootSessionId}`
  );
  return { turnId, pushedEventCount: 1 + tail.length };
}
