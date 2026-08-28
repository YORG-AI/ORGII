import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useMemo } from "react";

import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms/metadata";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  chatEventsForSessionAtomFamily,
  sessionSnapshotAtomFamily,
} from "@src/engines/SessionCore/derived/sessionScopedChatEvents";

const EMPTY_EVENTS: SessionEvent[] = [];

/**
 * Pipeline-scoped chat events for the active session store mirror.
 * Matches the old `derivedSnapshotAtom.chatEvents` source without
 * subscribing the whole ChatView shell to the full snapshot object.
 */
export function usePipelineChatEvents(): {
  pipelineSessionId: string | null;
  chatEvents: SessionEvent[];
  transcriptReady: boolean;
} {
  const pipelineSessionId = useAtomValue(sessionIdAtom);

  const chatEventsAtom = useMemo(
    () => chatEventsForSessionAtomFamily(pipelineSessionId ?? "__none__"),
    [pipelineSessionId]
  );
  const chatEvents = useAtomValue(chatEventsAtom);

  const transcriptReadyAtom = useMemo(
    () =>
      selectAtom(
        sessionSnapshotAtomFamily(pipelineSessionId ?? "__none__"),
        (state) => state.loadStarted
      ),
    [pipelineSessionId]
  );
  const transcriptReady = useAtomValue(transcriptReadyAtom);

  return {
    pipelineSessionId,
    chatEvents: pipelineSessionId ? chatEvents : EMPTY_EVENTS,
    transcriptReady: Boolean(pipelineSessionId && transcriptReady),
  };
}
