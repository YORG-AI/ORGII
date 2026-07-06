/**
 * Chat Events Derived Atoms
 *
 * Events filtered for ChatPanel display.
 * Now reads directly from the Rust-computed DerivedSnapshot.
 */
import { atom } from "jotai";

import { isSyntheticUserInputEvent } from "@src/engines/SessionCore/sync/utils/activityIds";
import {
  type QueuedMessage,
  messageQueueAtom,
} from "@src/store/ui/messageQueueAtom";

import { derivedSnapshotAtom, eventsAtom } from "../core/atoms/events";
import { sessionIdAtom } from "../core/atoms/metadata";
import type { Snapshot } from "../core/store/EventStoreProxy";
import type { SessionEvent } from "../core/types";
import { isVisibleInChat } from "../ingestion/visibilityFilters";
import {
  derivePlanDisplayEvents,
  planEventContentSignature,
} from "./planDisplayEvents";

function isStreamingSnap(snap: Snapshot): boolean {
  return "streaming" in snap && (snap as { streaming: boolean }).streaming;
}

/**
 * Events filtered for ChatPanel display.
 *
 * In the Rust EventStore architecture, chat events are pre-computed
 * and included in the DerivedSnapshot/StreamingSnapshot.
 * Falls back to JS-side filtering when snapshot is not available.
 *
 * Reference stability: returns the previous array reference when the
 * event list is structurally identical to avoid React re-renders.
 * During streaming, always returns fresh references because event
 * content grows while IDs stay the same.
 *
 * The prev cache is keyed by session ID so switching sessions always
 * produces a fresh array reference, preventing stale comparisons that
 * would silently skip re-renders on the incoming session's events.
 */
let _prevSessionId: string | null = null;
let _prevChatEvents: SessionEvent[] = [];
const _liveAssistantCreatedAtBySession = new Map<string, string>();

function getLiveAssistantCreatedAt(sessionId: string): string {
  const existing = _liveAssistantCreatedAtBySession.get(sessionId);
  if (existing) return existing;
  const createdAt = new Date().toISOString();
  _liveAssistantCreatedAtBySession.set(sessionId, createdAt);
  return createdAt;
}

function normalizeEventText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function getSyntheticUserText(event: SessionEvent): string {
  const resultMessage = event.result?.message;
  if (
    typeof resultMessage === "object" &&
    resultMessage !== null &&
    "content" in resultMessage
  ) {
    return normalizeEventText(String(resultMessage.content ?? ""));
  }
  return normalizeEventText(event.displayText);
}

function filterQueuedSyntheticUserEvents(
  events: SessionEvent[],
  queuedMessages: QueuedMessage[]
): SessionEvent[] {
  if (queuedMessages.length === 0) return events;
  const queuedBySession = new Map<string, Set<string>>();
  for (const message of queuedMessages) {
    let texts = queuedBySession.get(message.sessionId);
    if (!texts) {
      texts = new Set<string>();
      queuedBySession.set(message.sessionId, texts);
    }
    texts.add(normalizeEventText(message.content));
    texts.add(normalizeEventText(message.displayContent));
  }

  return events.filter((event) => {
    if (!isSyntheticUserInputEvent(event) || !event.sessionId) return true;
    const queuedTexts = queuedBySession.get(event.sessionId);
    if (!queuedTexts) return true;
    return !queuedTexts.has(getSyntheticUserText(event));
  });
}

function getAssistantText(event: SessionEvent): string {
  return normalizeEventText(
    event.displayText ||
      (event.result?.observation as string | undefined) ||
      (event.result?.content as string | undefined)
  );
}

function isFinalAssistantDuplicate(
  events: SessionEvent[],
  content: string,
  liveCreatedAt: string,
  sessionId: string
): boolean {
  const liveText = normalizeEventText(content);
  if (!liveText) return false;

  return events.some((event) => {
    if (event.sessionId !== sessionId) return false;
    if (event.source !== "assistant") return false;
    if (event.displayVariant !== "message") return false;
    if (event.displayStatus === "running") return false;
    if (event.isDelta === true) return false;

    if (liveText === "\u200b") {
      return Boolean(event.createdAt && event.createdAt >= liveCreatedAt);
    }

    return getAssistantText(event) === liveText;
  });
}

export function appendLiveAssistantEvent(
  events: SessionEvent[],
  sessionId: string | null,
  content: string | null
): SessionEvent[] {
  if (!sessionId || !content) {
    if (sessionId) _liveAssistantCreatedAtBySession.delete(sessionId);
    return events.filter((event) => event.id !== `live-assistant-${sessionId}`);
  }
  const liveId = `live-assistant-${sessionId}`;
  const createdAt = getLiveAssistantCreatedAt(sessionId);
  if (isFinalAssistantDuplicate(events, content, createdAt, sessionId)) {
    _liveAssistantCreatedAtBySession.delete(sessionId);
    return events.filter((event) => event.id !== liveId);
  }
  const liveEvent: SessionEvent = {
    id: liveId,
    chunk_id: null,
    sessionId,
    createdAt,
    functionName: "agent_message",
    uiCanonical: "agent_message",
    actionType: "assistant",
    args: { syntheticLive: true },
    result: { observation: content },
    source: "assistant",
    displayText: content,
    displayStatus: "running",
    displayVariant: "message",
    activityStatus: "agent",
    isDelta: true,
  };
  const withoutLive = events.filter((event) => event.id !== liveId);
  return [...withoutLive, liveEvent];
}

export const chatEventsAtom = atom((get) => {
  const snap = get(derivedSnapshotAtom);
  const sessionId = get(sessionIdAtom);

  // Reset prev cache when the active session changes so the stability
  // comparison never runs across two different sessions' event arrays.
  if (sessionId !== _prevSessionId) {
    _prevSessionId = sessionId;
    _prevChatEvents = [];
  }

  // During streaming, inject the live-assistant placeholder with a stable
  // sentinel so `appendLiveAssistantEvent` adds it to the list without
  // subscribing to `streamingDeltaContentAtom` (which fires on every token).
  // The actual streaming text is read directly from `streamingDeltaContentAtom`
  // inside `AgentMessageEvent` at the leaf renderer level.
  const streaming = snap ? isStreamingSnap(snap) : false;
  const liveContent = streaming && sessionId ? "\u200b" : null;
  const queuedMessages = get(messageQueueAtom);

  if (snap && "chatEvents" in snap) {
    const next = appendLiveAssistantEvent(
      derivePlanDisplayEvents(
        filterQueuedSyntheticUserEvents(snap.chatEvents, queuedMessages)
      ),
      sessionId,
      liveContent
    );

    // Short-circuit the O(n) args/plan scans when the event count changed —
    // a length mismatch already forces a new reference regardless of args.
    const sameLength = next.length === _prevChatEvents.length;
    const argsChanged = sameLength && !allArgsStable(next, _prevChatEvents);
    const planContentChanged =
      sameLength && !allPlanContentStable(next, _prevChatEvents);

    const tailUnchanged =
      next[next.length - 1]?.id ===
      _prevChatEvents[_prevChatEvents.length - 1]?.id;

    if (
      sameLength &&
      (tailUnchanged
        ? next.every((evt, i) => evt.id === _prevChatEvents[i].id)
        : false) &&
      (streaming
        ? lastEventStableIgnoreDisplayText(next, _prevChatEvents)
        : lastEventStable(next, _prevChatEvents)) &&
      !argsChanged &&
      !planContentChanged
    ) {
      return _prevChatEvents;
    }
    _prevChatEvents = next;
    return next;
  }

  // Fallback: no DerivedSnapshot yet (session switch, initial load, or only a
  // raw StreamingSnapshot without chatEvents). Filter JS-side, same as
  // messagesEventsAtom / simulatorEventsAtom do in their own fallback paths.
  const events = get(eventsAtom);
  return appendLiveAssistantEvent(
    derivePlanDisplayEvents(
      filterQueuedSyntheticUserEvents(
        events.filter(isVisibleInChat),
        queuedMessages
      )
    ),
    sessionId,
    liveContent
  );
});
chatEventsAtom.debugLabel = "session/chatEvents";

function lastEventStable(next: SessionEvent[], prev: SessionEvent[]): boolean {
  if (next.length === 0) return true;
  const lastN = next[next.length - 1];
  const lastP = prev[prev.length - 1];
  return (
    lastN.displayStatus === lastP.displayStatus &&
    lastN.isDelta === lastP.isDelta &&
    lastN.displayText === lastP.displayText
  );
}

/**
 * Same as `lastEventStable` but ignores `displayText` on the last event.
 *
 * Used during streaming: the live assistant placeholder's `displayText` grows
 * with every token, but the leaf renderer (`AgentMessageEvent`) reads the
 * actual streaming text directly from `streamingDeltaContentAtom`. Propagating
 * the growing text through `chatEventsAtom` → `optimizedChatHistory` →
 * `flatItems` would bust every GroupItemRenderer memo on every token.
 * Ignoring it here is safe because the ‌\u200b sentinel already guarantees
 * the placeholder event exists in the array; the renderer handles the rest.
 */
function lastEventStableIgnoreDisplayText(
  next: SessionEvent[],
  prev: SessionEvent[]
): boolean {
  if (next.length === 0) return true;
  const lastN = next[next.length - 1];
  const lastP = prev[prev.length - 1];
  return (
    lastN.displayStatus === lastP.displayStatus &&
    lastN.isDelta === lastP.isDelta
  );
}

/**
 * Check that no event's routing-relevant args have changed.
 *
 * We only check the fields that affect which adapter/block is rendered,
 * specifically `args.action` and `args.subagentSessionId`.  A deep
 * comparison of the full args object would be expensive; a shallow
 * reference check would always fail because every Tauri IPC call
 * deserialises into fresh JS objects.
 *
 * This catches the case where stamp_subagent_session_id_on_parent patches
 * `action: "delegate"` + `subagentSessionId` into a still-running tool_call
 * event whose displayStatus/isDelta do not change — the reference stability
 * check above would otherwise return the stale array and React would skip
 * the re-render that switches TitleOnlyAdapter → SubagentAdapter.
 */
function allArgsStable(next: SessionEvent[], prev: SessionEvent[]): boolean {
  if (next.length !== prev.length) return false;
  for (let i = 0; i < next.length; i++) {
    const na = next[i].args as Record<string, unknown> | undefined;
    const pa = prev[i].args as Record<string, unknown> | undefined;
    if (na?.["action"] !== pa?.["action"]) return false;
    if (na?.["subagentSessionId"] !== pa?.["subagentSessionId"]) return false;
  }
  return true;
}

function allPlanContentStable(
  next: SessionEvent[],
  prev: SessionEvent[]
): boolean {
  if (next.length !== prev.length) return false;
  for (let i = 0; i < next.length; i++) {
    if (
      planEventContentSignature(next[i]) !== planEventContentSignature(prev[i])
    ) {
      return false;
    }
  }
  return true;
}

/**
 * JS-side fallback filter for components that need immediate chat filtering
 * before the first snapshot arrives.
 */
export { isVisibleInChat };
