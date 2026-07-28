/**
 * User-message reconciliation helpers for session action atoms.
 *
 * Shared logic for reading/writing the user-message content+images shape
 * (which can live on `event.displayText` or `event.result.message`), and for
 * matching a synthetic user-input event against a still-parked frontend
 * message-queue entry. Extracted from actions.ts.
 */
import type { SessionEvent } from "../types";

function normalizeUserText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function getUserMessageContent(event: SessionEvent): string {
  return typeof event.result?.message === "object" &&
    event.result.message !== null &&
    "content" in event.result.message
    ? String(event.result.message.content ?? "")
    : event.displayText;
}

export function getUserMessageImages(
  event: SessionEvent
): string[] | undefined {
  const images = event.result?.images;
  if (!Array.isArray(images) || images.length === 0) return undefined;
  return images.filter((image): image is string => typeof image === "string");
}

export function hasUserMessageImages(event: SessionEvent): boolean {
  return Boolean(getUserMessageImages(event)?.length);
}

export function withUserMessageImages(
  event: SessionEvent,
  images: string[]
): SessionEvent {
  return {
    ...event,
    result: {
      ...(event.result ?? {}),
      images,
    },
  };
}

export function syntheticMatchesQueuedMessage(
  event: SessionEvent,
  queued: { sessionId: string; content: string; displayContent: string }
): boolean {
  if (event.sessionId !== queued.sessionId) return false;
  const eventText = normalizeUserText(event.displayText);
  const resultMessage = event.result?.message;
  const eventContent = normalizeUserText(
    typeof resultMessage === "object" &&
      resultMessage !== null &&
      "content" in resultMessage
      ? String(resultMessage.content ?? "")
      : event.displayText
  );
  const queuedDisplay = normalizeUserText(queued.displayContent);
  const queuedContent = normalizeUserText(queued.content);
  return (
    eventText === queuedDisplay ||
    eventText === queuedContent ||
    eventContent === queuedDisplay ||
    eventContent === queuedContent
  );
}
