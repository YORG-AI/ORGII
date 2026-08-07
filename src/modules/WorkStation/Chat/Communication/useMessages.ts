/**
 * useMessages Hook
 *
 * Manages state for the Messages simulator app.
 * Uses the base SimulatorAppState hook for replay integration.
 */
import { useAtomValue } from "jotai";
import { useCallback, useMemo, useState } from "react";

import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms";
import {
  getPlanEventAliases,
  isPlanDisplayEvent,
  planAliasesContain,
} from "@src/engines/SessionCore/derived/planDisplayEvents";
import { messagesEventsAtom } from "@src/engines/SessionCore/derived/simulatorEvents";
import { useSimulatorAppState } from "@src/engines/Simulator/apps/core/useSimulatorAppState";

import { MESSAGES_APP_CONFIG } from "./config";
import type {
  MessageEntry,
  MessageViewMode,
  SimulatorMessagesState,
} from "./types";

export interface UseMessagesOptions {
  /** Override current event ID (for testing) */
  overrideEventId?: string;
}

export interface UseMessagesReturn {
  /** Full app state */
  state: SimulatorMessagesState;
  /** Current view mode */
  viewMode: MessageViewMode;
  /** Set view mode */
  setViewMode: (mode: MessageViewMode) => void;
  /** Chat messages up to the current replay position (full list, scrollable) */
  chatMessages: MessageEntry[];
  /** Interactive widgets (ask_user, approval, mode-switch) */
  interactionMessages: MessageEntry[];
  /** Currently selected message */
  selectedMessage: MessageEntry | null;
  /** Whether selectedMessage was chosen by the user in this panel. */
  hasLocalSelection: boolean;
  /** Jump to a message's event or plan revision in replay */
  jumpToMessage: (messageId: string) => void;
}

function findMessageByIdOrPlanAlias(
  messages: readonly MessageEntry[],
  targetId: string
): MessageEntry | null {
  return (
    messages.find((message) => {
      if (message.eventId === targetId) return true;
      if (!isPlanDisplayEvent(message.event)) return false;
      return planAliasesContain(getPlanEventAliases(message.event), targetId);
    }) ?? null
  );
}

export function useMessages(
  options: UseMessagesOptions = {}
): UseMessagesReturn {
  const { overrideEventId } = options;

  // Messages app uses messagesEventsAtom (Rust snapshot field `messages_events`);
  // visibility matches simulator events (including user message turns).
  const { state: baseState } = useSimulatorAppState<SimulatorMessagesState>({
    config: MESSAGES_APP_CONFIG as never,
    overrideEventId,
    eventsAtomOverride: messagesEventsAtom,
  });
  // Local view mode state (overrides derived state)
  const [localViewMode, setLocalViewMode] = useState<MessageViewMode | null>(
    null
  );

  // Local selected message state
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);

  // Reset session-scoped local overrides whenever the active session changes.
  // Without this, switching from subagent → coordinator carries the old
  // `localSelectedId` (a stale event id from the previous session) into the
  // new session's message lists, which then fail to find a match and blank
  // out the sidebar selection for a few seconds until the user clicks again.
  // The same applies to `localViewMode` — e.g. a forced "todo" view from
  // the previous session leaking into a session with no todos.
  //
  // Uses the "Adjusting state while rendering" pattern from the React docs
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders):
  // store the previous session id in state and compare during render.
  const activeSessionId = useAtomValue(sessionIdAtom);
  const [trackedSessionId, setTrackedSessionId] = useState(activeSessionId);
  if (trackedSessionId !== activeSessionId) {
    setTrackedSessionId(activeSessionId);
    if (localSelectedId !== null) setLocalSelectedId(null);
    if (localViewMode !== null) setLocalViewMode(null);
  }

  const viewMode = localViewMode ?? baseState.viewMode;
  const selectedMessage = useMemo(() => {
    if (localSelectedId) {
      return (
        findMessageByIdOrPlanAlias(baseState.chatMessages, localSelectedId) ||
        findMessageByIdOrPlanAlias(baseState.thinkMessages, localSelectedId) ||
        findMessageByIdOrPlanAlias(baseState.todoMessages, localSelectedId) ||
        findMessageByIdOrPlanAlias(
          baseState.interactionMessages,
          localSelectedId
        )
      );
    }
    return baseState.selectedMessage;
  }, [
    localSelectedId,
    baseState.chatMessages,
    baseState.thinkMessages,
    baseState.todoMessages,
    baseState.interactionMessages,
    baseState.selectedMessage,
  ]);

  const jumpToMessage = useCallback((messageId: string) => {
    setLocalSelectedId(messageId);
  }, []);

  const setViewMode = useCallback((mode: MessageViewMode) => {
    setLocalViewMode(mode);
  }, []);

  return {
    state: {
      ...baseState,
      selectedMessage,
      viewMode,
    },
    viewMode,
    setViewMode,
    chatMessages: baseState.chatMessages,
    interactionMessages: baseState.interactionMessages,
    selectedMessage,
    hasLocalSelection: localSelectedId !== null,
    jumpToMessage,
  };
}

export default useMessages;
