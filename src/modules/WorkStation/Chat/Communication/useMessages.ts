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
import type { ReplayPrefetchEntry } from "./hooks/useReplayTurnPrefetch";
import { useReplayTurnPrefetch } from "./hooks/useReplayTurnPrefetch";
import type {
  MessageEntry,
  MessageViewMode,
  SimulatorMessagesState,
} from "./types";
import { getCommunicationUnloadedTurnMeta } from "./utils";

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
  /** Drop panel-local selection so replay cursor drives selection again. */
  clearLocalSelection: () => void;
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

  // Forward-prefetch unloaded turn bodies ahead of the replay cursor so
  // continuous playback doesn't hit a "Loading message…" beat on every
  // cold round (see useReplayTurnPrefetch for the full rationale).
  //
  // `messagesEventsAtom` is read directly here (not `baseState.chatMessages`)
  // because the cursor bounds what `useSimulatorAppState` renders — the
  // windowed `chatMessages` list never extends past `currentEventId`, so it
  // can't tell us what's coming up next. The full per-session event list is
  // already known once a session opens (only turn *bodies* are windowed),
  // so scanning it ahead of the cursor doesn't reveal anything the replay
  // wouldn't otherwise show, it just warms cache before the cursor gets
  // there. Kept a lightweight `{ eventId, unloadedTurn }` projection rather
  // than full `MessageEntry`s to skip `extractMessageContent`/
  // `getMessageSender` string work over the whole (unwindowed) transcript.
  const rawMessagesEvents = useAtomValue(messagesEventsAtom);
  const replayPrefetchEntries = useMemo<ReplayPrefetchEntry[]>(
    () =>
      rawMessagesEvents.map((event) => ({
        eventId: event.id,
        unloadedTurn: getCommunicationUnloadedTurnMeta(event),
      })),
    [rawMessagesEvents]
  );
  const replayCursorIndex = useMemo(() => {
    const currentEventId = baseState.currentEventId;
    if (!currentEventId) return -1;
    return replayPrefetchEntries.findIndex(
      (entry) => entry.eventId === currentEventId
    );
  }, [replayPrefetchEntries, baseState.currentEventId]);
  useReplayTurnPrefetch({
    sessionId: activeSessionId,
    entries: replayPrefetchEntries,
    cursorIndex: replayCursorIndex,
  });

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

  const clearLocalSelection = useCallback(() => {
    setLocalSelectedId(null);
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
    clearLocalSelection,
  };
}

export default useMessages;
