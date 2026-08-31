/**
 * SimulatorMessages Configuration
 *
 * Registry configuration for the Messages simulator app.
 * Sub-routing within CHANNELS uses getAppSubtool() — same pattern as
 * CODE_EDITOR's file_read/shell/search routing. No hardcoded event arrays.
 *
 * Rust AppSubtool is the single source of truth:
 * - "message"            → Messages timeline
 * - "thinking"           → Messages timeline
 * - "todo"               → Todo tab and Messages timeline
 * - "other_interactions" → interactions tab (ask_user, approval,
 *                          mode-switch)
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  derivePlanDisplayEvents,
  getPlanEventAliases,
  isPlanDisplayEvent,
} from "@src/engines/SessionCore/derived/planDisplayEvents";
import { getAppSubtool } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { isSyntheticUserInputEvent } from "@src/engines/SessionCore/sync/utils/activityIds";
import { defineSimulatorAppConfig } from "@src/engines/Simulator/apps/core/configFactory";
import { AppType } from "@src/engines/Simulator/types/appTypes";

import { isEmailBubbleEvent } from "./EmailMessageBubble";
import type { MessageEntry, SimulatorMessagesState } from "./types";
import {
  convertToMessageEntry,
  getCommunicationUnloadedTurnMeta,
  isAskQuestionEvent,
} from "./utils";

// ============================================
// State Derivation
// ============================================

function planMessageAliases(message: MessageEntry): string[] {
  if (!isPlanDisplayEvent(message.event)) return [message.eventId];
  return getPlanEventAliases(message.event);
}

function deriveInteractionMessages(messages: MessageEntry[]): MessageEntry[] {
  const derivedEvents = derivePlanDisplayEvents(
    messages.map((message) => message.event)
  );
  const orderByEventId = new Map<string, number>();
  const orderByPlanAlias = new Map<string, number>();
  const orderByTimestamp = new Map<string, number>();
  for (const message of messages) {
    orderByEventId.set(message.eventId, message.order);
    for (const alias of planMessageAliases(message)) {
      if (!orderByPlanAlias.has(alias)) {
        orderByPlanAlias.set(alias, message.order);
      }
    }
    if (!orderByTimestamp.has(message.event.createdAt)) {
      orderByTimestamp.set(message.event.createdAt, message.order);
    }
  }

  return derivedEvents.map((event) => {
    const aliasOrder = getPlanEventAliases(event)
      .map((alias) => orderByPlanAlias.get(alias))
      .find((order): order is number => order !== undefined);
    return convertToMessageEntry(
      event,
      "interaction",
      false,
      aliasOrder ??
        orderByEventId.get(event.id) ??
        orderByTimestamp.get(event.createdAt) ??
        Number.MAX_SAFE_INTEGER
    );
  });
}

function normalizeMessageDedupeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isOptimisticUserEvent(event: SessionEvent): boolean {
  return isSyntheticUserInputEvent(event);
}

function getCommunicationUserEchoKey(message: MessageEntry): string | null {
  if (message.sender !== "user") return null;
  const text = normalizeMessageDedupeText(message.content);
  if (!text) return null;
  return `${message.event.sessionId ?? ""}:${text}`;
}

function isUserRawEvent(event: SessionEvent): boolean {
  const functionName = event.functionName?.toLowerCase() || "";
  if (functionName !== "raw_event" && functionName !== "raw") {
    return true;
  }

  const result = event.result as Record<string, unknown> | undefined;
  if (result?.type === "user") {
    return true;
  }
  if (result?.message) {
    return true;
  }
  return event.source === "user";
}

/**
 * Detect `unloadedTurn` placeholder events whose real body has already
 * merged into the stream, and return the set of their event ids so
 * `buildMessageLists` can drop them.
 *
 * Why this is needed: the placeholder is supposed to disappear once its
 * turn's body loads — the chat panel gets this for free because
 * `projectChatGroups` (`ChatHistory/hooks/useChatGroupsProjection.ts`)
 * groups items by turn and nulls out a group's `unloadedTurn` the moment any
 * non-placeholder item shares that group (see `hasLoadedBodyItem` there).
 * The Rust `EventStore` is *also* supposed to strip the placeholder from its
 * own event list on merge (`merge_round_window_events` →
 * `remove_turn_placeholders_for_turns`), but that removal keys off
 * `is_turn_placeholder()`, which only recognizes the own-db/Codex-app
 * placeholder shape (`function_name === "turn_placeholder"` / id prefix
 * `turn-placeholder-`). Imported-history placeholders
 * (`imported_history/window.rs::build_unloaded_turn_placeholder_chunk`) use
 * a different shape (`function_name: "assistant"`, id
 * `imported-unloaded-turn-<turnId>`) that never matches, so for imported
 * sessions the placeholder silently survives the merge and stays visible in
 * `messages_events` forever, right alongside the body that loaded to
 * replace it.
 *
 * This surface has no turn-group projection of its own — it builds a flat
 * list straight from events — so it needs its own equivalent check: a
 * placeholder is "resolved" once a real (non-placeholder) event exists
 * between its turn's header event (`unloadedTurn.turnId`, which is also
 * that header event's own id — see `project_activity_chunks` /
 * `cache_load_session_turn_body`) and the next turn's header
 * (`unloadedTurn.nextTurnId`, or the end of the window when absent).
 */
function findResolvedUnloadedTurnPlaceholderIds(
  events: SessionEvent[]
): ReadonlySet<string> {
  let indexById: Map<string, number> | null = null;
  const resolved = new Set<string>();

  for (let i = 0; i < events.length; i++) {
    const meta = getCommunicationUnloadedTurnMeta(events[i]);
    if (!meta) continue;

    // Built lazily — most windows have zero placeholders, so most calls
    // never pay for the id index.
    if (!indexById) {
      indexById = new Map();
      for (let j = 0; j < events.length; j++) {
        indexById.set(events[j].id, j);
      }
    }

    const turnHeaderIndex = indexById.get(meta.turnId);
    // The turn's own header isn't in this (possibly windowed) event list —
    // there's nothing to anchor a body-range search to, so leave the
    // placeholder as-is rather than guess.
    if (turnHeaderIndex === undefined) continue;

    const nextTurnHeaderIndex = meta.nextTurnId
      ? indexById.get(meta.nextTurnId)
      : undefined;
    const rangeEnd = nextTurnHeaderIndex ?? events.length;
    const lo = Math.min(turnHeaderIndex, rangeEnd);
    const hi = Math.max(turnHeaderIndex, rangeEnd);

    for (let j = lo + 1; j < hi; j++) {
      if (j === i) continue;
      // Another placeholder isn't a loaded body event.
      if (getCommunicationUnloadedTurnMeta(events[j])) continue;
      resolved.add(events[i].id);
      break;
    }
  }

  return resolved;
}

/**
 * Build categorized message lists from events.
 *
 * Pure getAppSubtool() routing — same pattern as CODE_EDITOR:
 * - "message"  → Messages timeline
 * - "thinking" → Messages timeline
 * - "todo"     → Todo tab and Messages timeline
 */
interface MessageListsBuildResult {
  chatMessages: MessageEntry[];
  thinkMessages: MessageEntry[];
  todoMessages: MessageEntry[];
  interactionMessages: MessageEntry[];
  messageIndex: Map<string, MessageEntry>;
}

// Identity-keyed memo (same semantics as the previous single-slot
// `_prevBuildEvents` / `_prevBuildResult` module variables) but held in a
// WeakMap so the last-built session's full event array and MessageEntry
// trees are released as soon as the events array itself is dropped, instead
// of surviving unmount / session switch / session close.
const buildMessageListsMemo = new WeakMap<
  readonly SessionEvent[],
  MessageListsBuildResult
>();

function buildMessageLists(events: SessionEvent[]): MessageListsBuildResult {
  const memoized = buildMessageListsMemo.get(events);
  if (memoized) return memoized;

  const chatMessages: MessageEntry[] = [];
  const thinkMessages: MessageEntry[] = [];
  const todoMessages: MessageEntry[] = [];
  const interactionMessages: MessageEntry[] = [];
  const messageIndex = new Map<string, MessageEntry>();
  const pendingOptimisticUserMessages = new Map<string, MessageEntry>();
  const resolvedUnloadedTurnPlaceholderIds =
    findResolvedUnloadedTurnPlaceholderIds(events);

  for (const [eventIndex, event] of events.entries()) {
    // The placeholder's own turn body already merged into the stream (see
    // `findResolvedUnloadedTurnPlaceholderIds`) — drop it outright instead
    // of rendering it next to the content it stood in for. This lets
    // `UnloadedTurnBubble` unmount the same way it would if the Rust
    // EventStore had actually removed the placeholder on merge.
    if (resolvedUnloadedTurnPlaceholderIds.has(event.id)) continue;

    const subtool = getAppSubtool(event.functionName);
    const isPlanDoc = isPlanDisplayEvent(event);
    // User turns belong in the chat tab even if the tool registry does not
    // classify the event as a message.
    const isChatMessage = subtool === "message" || event.source === "user";

    if (subtool === "thinking") {
      const message = convertToMessageEntry(event, "think", false, eventIndex);
      thinkMessages.push(message);
      messageIndex.set(event.id, message);
    } else if (subtool === "todo") {
      const message = convertToMessageEntry(event, "todo", false, eventIndex);
      todoMessages.push(message);
      messageIndex.set(event.id, message);
    } else if (subtool === "other_interactions" || isPlanDoc) {
      const message = convertToMessageEntry(
        event,
        "interaction",
        false,
        eventIndex
      );
      interactionMessages.push(message);
      if (!isPlanDoc) {
        messageIndex.set(event.id, message);
      }
    } else if (isChatMessage) {
      if (!isUserRawEvent(event)) continue;
      const message = convertToMessageEntry(event, "chat", false, eventIndex);
      // Email-bubble tools (org_send_message, send_message, send_to_inbox)
      // carry their payload in tool-specific fields (text/summary, title/
      // content, ...) that `extractMessageContent` does not know about.
      // EmailMessageBubble owns its own per-tool parser, so admit them
      // unconditionally instead of dropping them via the hasContent gate.
      const isEmailBubble = isEmailBubbleEvent(event);
      const hasContent =
        isEmailBubble ||
        message.sender === "user" ||
        Boolean(message.content.trim()) ||
        isAskQuestionEvent(event);
      if (hasContent) {
        const userEchoKey = getCommunicationUserEchoKey(message);
        if (userEchoKey && isOptimisticUserEvent(event)) {
          pendingOptimisticUserMessages.set(userEchoKey, message);
        } else if (userEchoKey) {
          const optimistic = pendingOptimisticUserMessages.get(userEchoKey);
          if (optimistic) {
            const optimisticIndex = chatMessages.findIndex(
              (entry) => entry.eventId === optimistic.eventId
            );
            if (optimisticIndex !== -1) chatMessages.splice(optimisticIndex, 1);
            messageIndex.delete(optimistic.eventId);
            pendingOptimisticUserMessages.delete(userEchoKey);
          }
        }
        chatMessages.push(message);
        messageIndex.set(event.id, message);
      }
    }
  }

  const coalescedInteractionMessages =
    deriveInteractionMessages(interactionMessages);
  for (const message of coalescedInteractionMessages) {
    for (const alias of planMessageAliases(message)) {
      messageIndex.set(alias, message);
    }
  }

  const result: MessageListsBuildResult = {
    chatMessages,
    thinkMessages,
    todoMessages,
    interactionMessages: coalescedInteractionMessages,
    messageIndex,
  };
  buildMessageListsMemo.set(events, result);
  return result;
}

/**
 * Derive Messages state from events.
 * List building is memoized by events reference; only selection/viewMode
 * recomputes when currentEventId changes (O(1) Map lookup).
 */
export function deriveMessagesState(
  events: SessionEvent[],
  currentEventId: string | null
): Omit<
  SimulatorMessagesState,
  keyof import("@src/engines/Simulator/apps/core/types").SimulatorAppBaseState
> {
  const {
    chatMessages,
    thinkMessages,
    todoMessages,
    interactionMessages,
    messageIndex,
  } = buildMessageLists(events);

  // O(1) selection via pre-built index
  const selectedMessage =
    (currentEventId ? messageIndex.get(currentEventId) : null) ||
    interactionMessages[interactionMessages.length - 1] ||
    todoMessages[todoMessages.length - 1] ||
    chatMessages[chatMessages.length - 1] ||
    thinkMessages[thinkMessages.length - 1] ||
    null;

  let viewMode: MessageEntry["type"] = "chat";
  if (selectedMessage && currentEventId && messageIndex.has(currentEventId)) {
    viewMode = selectedMessage.type === "think" ? "chat" : selectedMessage.type;
  }

  return {
    chatMessages,
    thinkMessages,
    todoMessages,
    interactionMessages,
    selectedMessage,
    viewMode,
  };
}

// ============================================
// App Configuration
// ============================================

/**
 * Messages simulator app config.
 * Uses Rust registry for event matching.
 */
export const MESSAGES_APP_CONFIG =
  defineSimulatorAppConfig<SimulatorMessagesState>({
    appType: AppType.CHANNELS,
    name: "Communication",
    icon: "MessageCircle",
    deriveState: deriveMessagesState,
  });
