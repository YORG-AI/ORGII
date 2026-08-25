/**
 * useMessageDispatch
 *
 * Encapsulates message routing logic for all session types via the
 * dispatch registry. Each session category (rust_agent, cli_agent)
 * has its own dispatcher; this hook gathers React dependencies and
 * delegates to the correct one.
 */
import { useSetAtom } from "jotai";
import { useCallback } from "react";

import type { AgentExecMode } from "@src/config/sessionCreatorConfig";
import { resolveSessionAgentExecMode } from "@src/config/sessionCreatorConfig";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import {
  type ReservedTurnDispatch,
  sendReservedTurn,
} from "@src/engines/SessionCore/services/TurnDispatchService";
import { createSyntheticUserEvent } from "@src/engines/SessionCore/sync/adapters/shared";
import { lastUserMessageAtom } from "@src/store/session/cliSessionStatusAtom";
import {
  type LastModelSelection,
  creatorDefaultModelSelectionAtom,
} from "@src/store/session/creatorDefaultModelAtom";
import { sessionMapAtom } from "@src/store/session/sessionAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { resolveModelForMessage } from "@src/util/session/resolveModelForMessage";
import { selectionFromSession } from "@src/util/session/selectionFromSession";

export function useMessageDispatch() {
  const setLastUserMessage = useSetAtom(lastUserMessageAtom);

  const addUserMessage = useCallback(
    async (
      sessionId: string,
      content: string,
      imageDataUrls?: string[],
      turnIntentId?: string
    ): Promise<string> => {
      const userEvent = createSyntheticUserEvent(sessionId, content, {
        imageDataUrls,
        turnIntentId,
      });
      await eventStoreProxy.append([userEvent], sessionId);

      // Capture the exact text/images the user sent so the cancel-restore
      // path (Scenario A: cancel before any assistant output) can put it
      // back into the input box.
      setLastUserMessage({
        sessionId,
        displayContent: content,
        imageDataUrls,
      });
      return userEvent.id;
    },
    [setLastUserMessage]
  );

  const dispatchMessageBySessionType = useCallback(
    async (
      sessionId: string,
      content: string,
      reservedDispatch: ReservedTurnDispatch,
      imageDataUrls?: string[],
      modelSelectionOverride?: LastModelSelection,
      displayText?: string,
      clientMessageId?: string
    ): Promise<void> => {
      // Read directly from the store at call time to avoid stale-closure
      // race: if the user changes the mode pill and immediately sends a
      // message in the same React render batch, useAtomValue subscriptions
      // haven't re-rendered yet, so a closure-captured sessionMap would
      // still hold the pre-patch agentExecMode. getInstrumentedStore() reads
      // the live atom value synchronously, bypassing the render cycle.
      const store = getInstrumentedStore();
      const sessionMap = store.get(sessionMapAtom);
      const creatorDefaultSelection = store.get(
        creatorDefaultModelSelectionAtom
      );
      const session = sessionMap.get(sessionId);
      const lastModelSelection: LastModelSelection | null =
        modelSelectionOverride ??
        selectionFromSession(session, creatorDefaultSelection);
      const agentExecMode: AgentExecMode = resolveSessionAgentExecMode(
        session?.agentExecMode
      );
      const { model, accountId } = resolveModelForMessage(lastModelSelection);

      await sendReservedTurn({
        dispatch: reservedDispatch,
        content,
        displayText,
        model,
        accountId,
        mode: agentExecMode,
        imageDataUrls,
        clientMessageId,
        turnIntentSource: "user_submit",
        directUserIntent: true,
      });
    },
    []
  );

  return {
    addUserMessage,
    dispatchMessageBySessionType,
  };
}
