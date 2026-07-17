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
import { convertToMessageEntry, isAskQuestionEvent } from "./utils";

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
 * Build categorized message lists from events.
 *
 * Pure getAppSubtool() routing — same pattern as CODE_EDITOR:
 * - "message"  → Messages timeline
 * - "thinking" → Messages timeline
 * - "todo"     → Todo tab and Messages timeline
 */
let _prevBuildEvents: SessionEvent[] = [];
let _prevBuildResult: {
  chatMessages: MessageEntry[];
  thinkMessages: MessageEntry[];
  todoMessages: MessageEntry[];
  interactionMessages: MessageEntry[];
  messageIndex: Map<string, MessageEntry>;
} | null = null;

function buildMessageLists(events: SessionEvent[]) {
  if (events === _prevBuildEvents && _prevBuildResult) return _prevBuildResult;
  _prevBuildEvents = events;

  const chatMessages: MessageEntry[] = [];
  const thinkMessages: MessageEntry[] = [];
  const todoMessages: MessageEntry[] = [];
  const interactionMessages: MessageEntry[] = [];
  const messageIndex = new Map<string, MessageEntry>();
  const pendingOptimisticUserMessages = new Map<string, MessageEntry>();

  for (const [eventIndex, event] of events.entries()) {
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

  _prevBuildResult = {
    chatMessages,
    thinkMessages,
    todoMessages,
    interactionMessages: coalescedInteractionMessages,
    messageIndex,
  };
  return _prevBuildResult;
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
