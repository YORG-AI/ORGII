/**
 * Owner publisher — the owner's half of "every turn is on the plane".
 *
 * A member's turn reaches the plane through its one-shot runner; the
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
import {
  getLastTurnTerminal,
  getTurnPhase,
  turnLifecycleSignalAtom,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { extractChatEvents } from "@src/engines/SessionCore/core/store/useSessionEvents";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  boundConversationEventForPush,
  pushConversationEventsChunked,
} from "../org2CloudConversationEventsClient";
import { conversationEventKey } from "./conversationTimeline";

const log = createLogger("ConversationOwnerPublisher");

const TURN_DEADLINE_MS = 15 * 60_000;

export function turnIntentIdOf(event: SessionEvent): string | null {
  if (event.source !== "user") return null;
  const intent = (event.result as { turnIntentId?: unknown } | undefined)
    ?.turnIntentId;
  return typeof intent === "string" && intent.length > 0 ? intent : null;
}

export function findUserEventByIntent(
  events: readonly SessionEvent[],
  turnIntentId: string
): SessionEvent | null {
  return events.find((event) => turnIntentIdOf(event) === turnIntentId) ?? null;
}

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
  return {
    id: userEvent.id,
    chunk_id: userEvent.id,
    sessionId: "conversation",
    createdAt: userEvent.createdAt,
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: {
      type: "user",
      message: { content: displayText, role: "user" },
      ...(turnIntentId ? { turnIntentId } : {}),
    },
    source: "user",
    displayText,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  } as SessionEvent;
}

/**
 * The agent tail of one turn: every non-user event after the turn's user
 * row, up to the next turn's user row. `null` when the user row is not in
 * the transcript (the dispatch failed and removed it).
 */
export function sliceOwnerTurnTail(
  events: readonly SessionEvent[],
  turnIntentId: string
): SessionEvent[] | null {
  const start = events.findIndex(
    (event) => turnIntentIdOf(event) === turnIntentId
  );
  if (start < 0) return null;
  const turnKey = conversationEventKey(events[start]);
  const tail: SessionEvent[] = [];
  for (let index = start + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event.source === "user") {
      if (conversationEventKey(event) !== turnKey) break;
      continue;
    }
    tail.push(event);
  }
  return tail;
}

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

function waitForTurnEnd(
  sessionId: string,
  userEventMs: number,
  deadlineMs: number
): Promise<void> {
  const store = getInstrumentedStore();
  const isDone = (): boolean =>
    getTurnPhase(sessionId) === "idle" &&
    (getLastTurnTerminal(sessionId)?.at ?? 0) >= userEventMs;
  if (isDone()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      reject(new Error("owner turn timed out"));
      return;
    }
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error("owner turn timed out"));
    }, remainingMs);
    const check = (): void => {
      if (!isDone()) return;
      clearTimeout(timer);
      unsubscribe?.();
      resolve();
    };
    unsubscribe = store.sub(turnLifecycleSignalAtom, check);
    check();
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
  const turnId = crypto.randomUUID();
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

  const userEventMs = new Date(userEvent.createdAt).getTime();
  await waitForTurnEnd(
    params.sessionId,
    Number.isFinite(userEventMs) ? userEventMs : 0,
    deadlineMs
  );
  const persisted = await eventStoreProxy
    .getPersistedEvents(params.sessionId)
    .catch(() => [] as SessionEvent[]);
  const tail = sliceOwnerTurnTail(persisted, params.turnIntentId) ?? [];
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
