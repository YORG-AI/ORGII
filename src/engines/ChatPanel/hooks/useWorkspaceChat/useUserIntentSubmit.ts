/**
 * useUserIntentSubmit
 *
 * Single frontend entry point for user-intent turns: composer submits,
 * interactive cards, and edit-resubmit flows all append the synthetic user
 * event and dispatch through this hook so turnIntentId, queueing, and FSM
 * reservation stay aligned.
 */
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect } from "react";

import { enterAgentOrgSessionIntervention } from "@src/api/tauri/agent";
import type { AgentExecMode } from "@src/config/sessionCreatorConfig";
import {
  beginOptimisticTurn,
  failOptimisticTurn,
} from "@src/engines/SessionCore/control/optimisticTurnStatus";
import {
  beginTurnDispatch,
  getTurnPhase,
  markTurnTerminal,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { mintTurnIntentId } from "@src/engines/SessionCore/sync/adapters/shared/eventFactories";
import { createLogger } from "@src/hooks/logger";
import {
  type SessionRuntimeStatusSource,
  isSessionActiveAtom,
  lastUserMessageAtom,
  userInitiatedCancelAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { creatorDefaultExecModeAtom } from "@src/store/session/creatorDefaultExecModeAtom";
import { creatorDefaultModelSelectionAtom } from "@src/store/session/creatorDefaultModelAtom";
import { sessionMapAtom } from "@src/store/session/sessionAtom";
import {
  enqueueMessageAtom,
  messageQueueAtom,
  queueFlushRequestAtom,
} from "@src/store/ui/messageQueueAtom";
import { selectionFromSession } from "@src/util/session/selectionFromSession";

import {
  consumeRestoredStopDraft,
  consumeRestoredStopSubmitSuppression,
} from "./stopSubmitGuard";
import { useMessageDispatch } from "./useMessageDispatch";

const log = createLogger("useUserIntentSubmit");

const sharedSubmitGuard = { current: false };
const sharedSubmitPayload = { current: null as string | null };

function buildSubmitPayloadKey(
  sessionId: string,
  displayContent: string,
  agentContent?: string,
  imageDataUrls?: string[]
): string {
  return JSON.stringify({
    sessionId,
    displayContent,
    agentContent: agentContent ?? null,
    imageDataUrls: imageDataUrls ?? [],
  });
}

function stableSubmitHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export interface SubmitUserIntentOptions {
  sessionId?: string | null;
  displayContent: string;
  agentContent?: string;
  imageDataUrls?: string[];
  source?: SessionRuntimeStatusSource;
  applyStopSubmitGuards?: boolean;
  dedupeDirectSubmit?: boolean;
  clearUserInitiatedCancelOnQueue?: boolean;
  swallowErrorAfterUserEventAppend?: boolean;
  onQueued?: () => void;
  onBeforeDirectDispatch?: () => void;
}

interface UseUserIntentSubmitOptions {
  getSessionId: () => string | null;
}

export function useUserIntentSubmit({
  getSessionId,
}: UseUserIntentSubmitOptions) {
  const store = useStore();
  const isSessionActive = useAtomValue(isSessionActiveAtom);
  const enqueueMessage = useSetAtom(enqueueMessageAtom);
  const setQueueFlushRequest = useSetAtom(queueFlushRequestAtom);
  const setLastUserMessage = useSetAtom(lastUserMessageAtom);
  const setUserInitiatedCancel = useSetAtom(userInitiatedCancelAtom);
  const { addUserMessage, dispatchMessageBySessionType } = useMessageDispatch({
    getSessionId,
  });

  useEffect(() => {
    if (!isSessionActive) {
      sharedSubmitGuard.current = false;
      sharedSubmitPayload.current = null;
    }
  }, [isSessionActive]);

  return useCallback(
    async ({
      sessionId: explicitSessionId,
      displayContent,
      agentContent,
      imageDataUrls,
      source = "dispatch",
      applyStopSubmitGuards = false,
      dedupeDirectSubmit = false,
      clearUserInitiatedCancelOnQueue = false,
      swallowErrorAfterUserEventAppend = false,
      onQueued,
      onBeforeDirectDispatch,
    }: SubmitUserIntentOptions): Promise<void> => {
      const sessionId = explicitSessionId ?? getSessionId();
      if (!sessionId) {
        throw new Error("[useUserIntentSubmit] no active sessionId");
      }

      const contentForAgent = agentContent ?? displayContent;
      const restoreImageDataUrls =
        imageDataUrls && imageDataUrls.length > 0 ? imageDataUrls : undefined;
      const submitPayloadKey = buildSubmitPayloadKey(
        sessionId,
        displayContent,
        agentContent,
        imageDataUrls
      );
      const turnIntentId = mintTurnIntentId();

      if (
        applyStopSubmitGuards &&
        consumeRestoredStopSubmitSuppression({
          sessionId,
          displayContent,
          imageDataUrls,
        })
      ) {
        return;
      }

      const restoredStopDraftSubmit = applyStopSubmitGuards
        ? consumeRestoredStopDraft({
            sessionId,
            displayContent,
            imageDataUrls,
          })
        : false;
      const explicitPostStopSubmit =
        restoredStopDraftSubmit || store.get(userInitiatedCancelAtom);

      if (
        dedupeDirectSubmit &&
        sharedSubmitGuard.current &&
        sharedSubmitPayload.current === submitPayloadKey
      ) {
        return;
      }

      const hasQueuedNaturalSibling = store
        .get(messageQueueAtom)
        .some(
          (message) =>
            message.sessionId === sessionId && !message.requiresExplicitDispatch
        );
      const shouldEnqueue =
        explicitPostStopSubmit ||
        getTurnPhase(sessionId) !== "idle" ||
        hasQueuedNaturalSibling;

      if (shouldEnqueue) {
        const session = store.get(sessionMapAtom).get(sessionId);
        const creatorDefaultSelection = store.get(
          creatorDefaultModelSelectionAtom
        );
        const snapshotSelection = selectionFromSession(
          session,
          creatorDefaultSelection
        );
        const snapshotMode: AgentExecMode =
          (session?.agentExecMode as AgentExecMode | undefined) ??
          store.get(creatorDefaultExecModeAtom);

        if (clearUserInitiatedCancelOnQueue && explicitPostStopSubmit) {
          setUserInitiatedCancel(false);
        }

        enqueueMessage({
          id: `queued-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          turnIntentId,
          sessionId,
          content: contentForAgent,
          displayContent,
          imageDataUrls,
          modelSelection: snapshotSelection ?? undefined,
          agentExecMode: snapshotMode,
          priority: explicitPostStopSubmit ? "now" : "next",
          status: "queued",
          createdAt: new Date().toISOString(),
        });
        if (explicitPostStopSubmit) {
          setQueueFlushRequest((requestId) => requestId + 1);
        }
        if (!explicitPostStopSubmit) {
          beginOptimisticTurn(sessionId, "queue");
        }
        onQueued?.();
        return;
      }

      setLastUserMessage({
        sessionId,
        displayContent,
        imageDataUrls: restoreImageDataUrls,
      });
      const dispatchGeneration = beginTurnDispatch(sessionId);
      beginOptimisticTurn(sessionId, source);
      if (dedupeDirectSubmit) {
        sharedSubmitGuard.current = true;
        sharedSubmitPayload.current = submitPayloadKey;
      }

      let userEventAppended = false;
      let dispatchStarted = false;
      try {
        onBeforeDirectDispatch?.();
        await addUserMessage(displayContent, imageDataUrls, turnIntentId);
        userEventAppended = true;
        void enterAgentOrgSessionIntervention(sessionId).catch((error) => {
          log.warn("[useUserIntentSubmit] intervention failed:", error);
        });
        const displayTextForDispatch =
          contentForAgent !== displayContent ? displayContent : undefined;
        dispatchStarted = true;
        await dispatchMessageBySessionType(
          sessionId,
          contentForAgent,
          imageDataUrls,
          undefined,
          displayTextForDispatch,
          `direct:${sessionId}:${stableSubmitHash(submitPayloadKey)}`,
          turnIntentId,
          dispatchGeneration
        );
      } catch (error) {
        if (dedupeDirectSubmit) {
          sharedSubmitGuard.current = false;
          sharedSubmitPayload.current = null;
        }
        if (!dispatchStarted) {
          failOptimisticTurn(sessionId, source);
          markTurnTerminal(sessionId, "failed", {
            generation: dispatchGeneration,
          });
        }
        if (!userEventAppended || !swallowErrorAfterUserEventAppend) {
          throw error;
        }
      }
    },
    [
      addUserMessage,
      dispatchMessageBySessionType,
      enqueueMessage,
      getSessionId,
      setLastUserMessage,
      setQueueFlushRequest,
      setUserInitiatedCancel,
      store,
    ]
  );
}
