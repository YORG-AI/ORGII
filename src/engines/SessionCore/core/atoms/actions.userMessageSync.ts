/**
 * User-message reconciliation helpers for session action atoms.
 *
 * Shared logic for reading/writing the user-message content+images shape
 * (which can live on `event.displayText` or `event.result.message`), and for
 * matching a synthetic user-input event against a still-parked frontend
 * message-queue entry. Extracted from actions.ts.
 */
import { turnIntentIdOf } from "../../sync/utils/activityIds";
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

/**
 * Whether a synthetic user placeholder is settled by a batch of real backend
 * user messages (summarized as a SyntheticEvictionScope): its echo is present
 * (content match on either its display text or wire content), or it predates
 * the newest real user turn so its echo can no longer arrive. Unsettled
 * placeholders are messages still awaiting their echo and must be preserved.
 */
export function syntheticSettledByScope(
  event: SessionEvent,
  scope: {
    matchingContents: string[];
    matchingTurnIntentIds: string[];
    olderThan?: string;
  } | null
): boolean {
  if (!scope) return false;
  const turnIntentId = turnIntentIdOf(event);
  // A submit-boundary placeholder has a durable logical identity. Timestamp
  // order is not evidence for these rows: native replay/materialization can
  // legitimately re-stamp an older turn after the new optimistic row was
  // created. Only the matching backend intent may settle it. Content and
  // timestamp remain the compatibility path for legacy placeholders.
  if (turnIntentId) {
    return scope.matchingTurnIntentIds.includes(turnIntentId);
  }
  const targets = new Set(scope.matchingContents.map(normalizeUserText));
  const eventTexts = [
    normalizeUserText(event.displayText),
    normalizeUserText(getUserMessageContent(event)),
  ].filter((text) => text.length > 0);
  if (eventTexts.some((text) => targets.has(text))) return true;
  return Boolean(
    scope.olderThan && event.createdAt && event.createdAt < scope.olderThan
  );
}
