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
import {
  beginOptimisticTurn,
  failOptimisticTurn,
} from "@src/engines/SessionCore/control/optimisticTurnStatus";
import {
  beginTurnDispatch,
  confirmTurnRunning,
  markTurnTerminal,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { createSyntheticUserEvent } from "@src/engines/SessionCore/sync/adapters/shared";
import { markSessionActive } from "@src/store/session";
import {
  lastUserMessageAtom,
  setSessionRuntimeStatusAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { creatorDefaultExecModeAtom } from "@src/store/session/creatorDefaultExecModeAtom";
import {
  type LastModelSelection,
  creatorDefaultModelSelectionAtom,
} from "@src/store/session/creatorDefaultModelAtom";
import { sessionMapAtom } from "@src/store/session/sessionAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { resolveModelForMessage } from "@src/util/session/resolveModelForMessage";
import { selectionFromSession } from "@src/util/session/selectionFromSession";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";

interface UseMessageDispatchOptions {
  getSessionId: () => string | null;
}

export function useMessageDispatch(options: UseMessageDispatchOptions) {
  const { getSessionId } = options;
  const setSessionRuntimeStatus = useSetAtom(setSessionRuntimeStatusAtom);
  const setLastUserMessage = useSetAtom(lastUserMessageAtom);

  const addUserMessage = useCallback(
    async (
      content: string,
      imageDataUrls?: string[],
      turnIntentId?: string
    ): Promise<void> => {
      const sessionId = getSessionId();
      if (!sessionId) {
        throw new Error(
          "[useMessageDispatch] addUserMessage: no active sessionId"
        );
      }
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
    },
    [getSessionId, setLastUserMessage]
  );

  const dispatchMessageBySessionType = useCallback(
    async (
      sessionId: string,
      content: string,
      imageDataUrls?: string[],
      modelSelectionOverride?: LastModelSelection,
      displayText?: string,
      clientMessageId?: string,
      turnIntentId?: string,
      reservedDispatchGeneration?: number
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
      const creatorDefaultMode = store.get(creatorDefaultExecModeAtom);

      const session = sessionMap.get(sessionId);
      const lastModelSelection: LastModelSelection | null =
        modelSelectionOverride ??
        selectionFromSession(session, creatorDefaultSelection);
      const agentExecMode: AgentExecMode =
        (session?.agentExecMode as AgentExecMode | undefined) ??
        creatorDefaultMode;
      const { model, accountId } = resolveModelForMessage(lastModelSelection);

      // Synchronous turn reserve: every dispatch funnels through here, so the
      // FSM observes the session as busy before the first await. A concurrent
      // submit therefore queues instead of double-dispatching.
      const dispatchGeneration =
        reservedDispatchGeneration ?? beginTurnDispatch(sessionId);

      beginOptimisticTurn(sessionId);

      try {
        await SessionService.sendMessage({
          sessionId,
          content,
          displayText,
          model,
          accountId,
          mode: agentExecMode,
          imageDataUrls,
          clientMessageId,
          turnIntentId,
        });
        // Backend accepted the message — the turn is running even if the
        // provider's running ack has not been observed yet.
        confirmTurnRunning(sessionId);
        // Bump the row's `updated_at` to "now" so the sidebar /
        // Kanban "recent activity" views float this session to the
        // top immediately. The backend's authoritative timestamp
        // lands on the next session list refresh and overwrites
        // this — see `markSessionActive` doc for the policy.
        markSessionActive(sessionId);
        if (isCursorIdeSession(sessionId)) {
          // Cursor IDE sessions have no turn lifecycle (the CDP stream has no
          // terminal event) — close the turn right after a successful handoff.
          setSessionRuntimeStatus({
            sessionId,
            status: "idle",
            source: "dispatch",
          });
          markTurnTerminal(sessionId, "completed", {
            generation: dispatchGeneration,
          });
        }
      } catch (err) {
        // IPC failed before Rust even received the message — reset so the UI
        // does not stay stuck in the optimistic "running" state.
        failOptimisticTurn(sessionId);
        markTurnTerminal(sessionId, "failed", {
          generation: dispatchGeneration,
        });
        throw err;
      }
    },
    [setSessionRuntimeStatus]
  );

  return {
    addUserMessage,
    dispatchMessageBySessionType,
  };
}
