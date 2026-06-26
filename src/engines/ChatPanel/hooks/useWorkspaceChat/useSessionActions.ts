/**
 * useSessionActions
 *
 * Encapsulates session resume and interrupt logic via the dispatch registry.
 */
import { useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import { willEventRenderContent } from "@src/engines/ChatPanel/ChatHistory/chatItemPipeline/filters";
import {
  beginOptimisticTurn,
  failOptimisticTurn,
} from "@src/engines/SessionCore/control/optimisticTurnStatus";
import {
  beginStopBoundary,
  cancelTurnForTimelineBoundary,
  clearLiveStreamingForSession,
} from "@src/engines/SessionCore/control/sessionTimelineBoundary";
import { forceTurnIdle } from "@src/engines/SessionCore/control/turnLifecycle";
import { pendingSyntheticEventAtom } from "@src/engines/SessionCore/core/atoms";
import { eventsAtom } from "@src/engines/SessionCore/core/atoms/events";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { clearSessionStreamingStopped } from "@src/engines/SessionCore/sync/adapters/rustAgent/eventHandlers/streamHelpers";
import { createLogger } from "@src/hooks/logger";
import {
  isPendingCancelAtom,
  lastUserMessageAtom,
  restoreToInputAtom,
  sessionRolledBackAtom,
  sessionRuntimeStatusAtom,
  setSessionRuntimeStatusAtom,
} from "@src/store/session/cliSessionStatusAtom";

import {
  markRestoredStopDraft,
  suppressRestoredStopSubmit,
} from "./stopSubmitGuard";

const log = createLogger("useSessionActions");

interface RestorableUserMessage {
  displayContent: string;
  imageDataUrls?: string[];
}

function readImageDataUrls(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const images = value.filter(
    (item): item is string => typeof item === "string"
  );
  return images.length > 0 ? images : undefined;
}

export function resolveRestorableUserMessage(options: {
  snapshotDisplayText?: string;
  snapshotImages?: unknown;
  lastUserMessage?: RestorableUserMessage | null;
  pendingDisplayText?: string;
  pendingImages?: unknown;
}): RestorableUserMessage | null {
  const snapshotImages = readImageDataUrls(options.snapshotImages);
  const pendingImages = readImageDataUrls(options.pendingImages);

  if (options.snapshotDisplayText) {
    const fallbackImages =
      options.lastUserMessage?.displayContent === options.snapshotDisplayText
        ? options.lastUserMessage.imageDataUrls
        : undefined;
    return {
      displayContent: options.snapshotDisplayText,
      imageDataUrls: snapshotImages ?? fallbackImages,
    };
  }

  if (options.lastUserMessage) {
    return options.lastUserMessage;
  }

  if (options.pendingDisplayText) {
    return {
      displayContent: options.pendingDisplayText,
      imageDataUrls: pendingImages,
    };
  }

  return null;
}

export function shouldRestoreStoppedUserMessage(options: {
  events: SessionEvent[];
  sessionId: string;
  message: RestorableUserMessage | null;
}): boolean {
  if (!options.message) return false;

  const { message } = options;
  let userEventIndex = -1;
  for (let index = options.events.length - 1; index >= 0; index -= 1) {
    const event = options.events[index];
    if (
      event.sessionId === options.sessionId &&
      event.source === "user" &&
      event.displayText === message.displayContent
    ) {
      userEventIndex = index;
      break;
    }
  }
  if (userEventIndex === -1) return true;

  return !options.events
    .slice(userEventIndex + 1)
    .some(
      (event) =>
        event.sessionId === options.sessionId &&
        event.source !== "user" &&
        willEventRenderContent(event)
    );
}

interface UseSessionActionsOptions {
  getSessionId: () => string | null;
}

export function useSessionActions(options: UseSessionActionsOptions) {
  const { getSessionId } = options;
  const { t } = useTranslation("sessions");
  const store = useStore();
  const setPendingCancel = useSetAtom(isPendingCancelAtom);
  const setRestoreToInput = useSetAtom(restoreToInputAtom);
  const setSessionRolledBack = useSetAtom(sessionRolledBackAtom);
  const setSessionRuntimeStatus = useSetAtom(setSessionRuntimeStatusAtom);
  const stopVisibleStreaming = useCallback((sessionId: string) => {
    clearLiveStreamingForSession(sessionId);
  }, []);

  const resumeSession = useCallback(async () => {
    const sessionId = getSessionId();
    if (!sessionId) {
      Message.error(t("errors.noSessionIdFound"));
      return;
    }

    try {
      clearSessionStreamingStopped(sessionId);
      // Resume bypasses useMessageDispatch — without the optimistic running
      // the panel looks dead until Rust's first status event (#9).
      beginOptimisticTurn(sessionId);
      await SessionService.resumeCli({
        sessionId,
        onError: (msg: string) => {
          Message.error(t(msg));
        },
      });
    } catch (err) {
      log.error("[useSessionActions] resume failed:", err);
      failOptimisticTurn(sessionId);
      Message.error(t("errors.failedToResume"));
    }
  }, [getSessionId, t]);

  /**
   * Interrupt the current turn (user Stop).
   *
   * Send Now interrupts are NOT routed here — the queue dispatcher issues its
   * own "force-send" timeline boundary.
   *
   * Stop is an O(1) timeline boundary: it updates local runtime state, restores
   * the click-time prompt to the composer, and signals Rust cancellation. It
   * must not read/repair DB history or scan/mutate the EventStore.
   */
  const interruptSession = useCallback(async () => {
    const sessionId = getSessionId();
    if (!sessionId) {
      log.error("[useSessionActions] No session ID found for interrupt");
      return;
    }

    beginStopBoundary(sessionId);
    setSessionRolledBack(false);

    const pendingSyntheticEvent = store.get(pendingSyntheticEventAtom);
    const currentUserMessage = resolveRestorableUserMessage({
      lastUserMessage: store.get(lastUserMessageAtom),
      pendingDisplayText:
        pendingSyntheticEvent?.source === "user"
          ? pendingSyntheticEvent.displayText
          : undefined,
      pendingImages: pendingSyntheticEvent?.result?.images,
    });

    const restorableMessage = currentUserMessage;
    if (
      restorableMessage &&
      shouldRestoreStoppedUserMessage({
        events: store.get(eventsAtom),
        sessionId,
        message: restorableMessage,
      })
    ) {
      setRestoreToInput({
        sessionId,
        displayContent: restorableMessage.displayContent,
        imageDataUrls: restorableMessage.imageDataUrls,
      });
      markRestoredStopDraft({
        sessionId,
        displayContent: restorableMessage.displayContent,
        imageDataUrls: restorableMessage.imageDataUrls,
      });
      suppressRestoredStopSubmit({
        sessionId,
        displayContent: restorableMessage.displayContent,
        imageDataUrls: restorableMessage.imageDataUrls,
      });
    }

    void (async () => {
      window.setTimeout(() => {
        const latestStatus = store.get(sessionRuntimeStatusAtom);
        const runtimeStartedAnotherTurn =
          latestStatus === "running" ||
          latestStatus === "installing" ||
          latestStatus === "waiting_for_user" ||
          latestStatus === "waiting_for_funds";
        if (runtimeStartedAnotherTurn) return;
        setPendingCancel(false);
        setSessionRuntimeStatus({
          sessionId,
          status: "idle",
          source: "timeline-boundary",
        });
        stopVisibleStreaming(sessionId);
      }, 10_000);

      await cancelTurnForTimelineBoundary(sessionId, "stop", {
        onError: (msg: string) => {
          Message.error(t(msg));
          setPendingCancel(false);
          setSessionRuntimeStatus({
            sessionId,
            status: "idle",
            source: "timeline-boundary",
          });
          stopVisibleStreaming(sessionId);
          // Interrupt RPC failed — no terminal will arrive, unlock now.
          forceTurnIdle(sessionId);
        },
      });
    })();
  }, [
    getSessionId,
    setPendingCancel,
    setRestoreToInput,
    setSessionRolledBack,
    setSessionRuntimeStatus,
    stopVisibleStreaming,
    store,
    t,
  ]);

  /** User-initiated stop entrypoint kept separate for call-site clarity. */
  const stopSession = interruptSession;

  return { resumeSession, interruptSession, stopSession };
}
