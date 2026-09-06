/**
 * useMessageDispatch
 *
 * Encapsulates message routing logic for all session types via the
 * dispatch registry. Each session category (rust_agent, cli_agent)
 * has its own dispatcher; this hook gathers React dependencies and
 * delegates to the correct one.
 */
import { useCallback } from "react";

import type { AgentExecMode } from "@src/config/sessionCreatorConfig";
import { resolveSessionAgentExecMode } from "@src/config/sessionCreatorConfig";
import {
  type DispatchUserIntentResult,
  dispatchUserIntent,
} from "@src/engines/SessionCore/services/userIntentDispatch";
import type { SessionRuntimeStatusSource } from "@src/store/session/cliSessionStatusAtom";
import {
  type LastModelSelection,
  creatorDefaultModelSelectionAtom,
} from "@src/store/session/creatorDefaultModelAtom";
import { sessionMapAtom } from "@src/store/session/sessionAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { resolveModelForMessage } from "@src/util/session/resolveModelForMessage";
import { selectionFromSession } from "@src/util/session/selectionFromSession";

export interface MessageDispatchInput {
  sessionId: string;
  content: string;
  visibleText: string;
  imageDataUrls?: string[];
  modelSelectionOverride?: LastModelSelection;
  displayText?: string;
  clientMessageId?: string;
  turnIntentId: string;
  runtimeStatusSource?: SessionRuntimeStatusSource;
  beforeAppend?: () => void | Promise<void>;
}

export function useMessageDispatch() {
  const dispatchMessageBySessionType = useCallback(
    async ({
      sessionId,
      content,
      visibleText,
      imageDataUrls,
      modelSelectionOverride,
      displayText,
      clientMessageId,
      turnIntentId,
      runtimeStatusSource = "dispatch",
      beforeAppend,
    }: MessageDispatchInput): Promise<DispatchUserIntentResult> => {
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

      return dispatchUserIntent({
        sessionId,
        visibleText,
        imageDataUrls,
        runtimeStatusSource,
        beforeAppend,
        send: {
          content,
          displayText,
          model,
          accountId,
          mode: agentExecMode,
          clientMessageId,
          turnIntentId,
          turnIntentSource: "user_submit",
          directUserIntent: true,
        },
      });
    },
    []
  );

  return { dispatchMessageBySessionType };
}
