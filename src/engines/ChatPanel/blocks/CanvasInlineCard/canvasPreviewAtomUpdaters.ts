import type { CanvasPreviewEntry } from "@src/store/session/canvasPreviewAtom";

import type { CanvasInlinePayload } from "./types";

/** Soft-dismiss — hides inline card, keeps payload for pill / tab reopen. */
export function applyDismissCanvasEntry(
  prev: CanvasPreviewEntry | null
): CanvasPreviewEntry | null {
  return prev ? { ...prev, cardDismissed: true } : null;
}

/** Hard-clear — removes the atom entry entirely. */
export function applyClearCanvasEntry(): null {
  return null;
}

/**
 * Dismiss canvas when a new agent turn starts. Only affects the matching
 * session and is idempotent when already dismissed.
 */
export function applyDismissCanvasAtNewTurn(
  prev: CanvasPreviewEntry | null,
  sessionId: string
): CanvasPreviewEntry | null {
  if (!prev || prev.sessionId !== sessionId || prev.cardDismissed) return prev;
  return applyDismissCanvasEntry(prev);
}

/**
 * Clear stored canvas when switching to a different session. Only one entry is
 * stored at a time, so the entire atom is nulled on an actual session switch.
 */
export function applyClearCanvasOnSessionSwitch(
  prev: CanvasPreviewEntry | null,
  leavingSessionId: string | null,
  enteringSessionId: string
): CanvasPreviewEntry | null {
  if (!prev) return null;
  if (!leavingSessionId || leavingSessionId === enteringSessionId) return prev;
  return null;
}

/** Payload visible for inline card / streaming overlay (not dismissed). */
export function deriveCanvasPayloadForSession(
  entry: CanvasPreviewEntry | null,
  sessionId: string | null | undefined
): CanvasInlinePayload | null {
  if (!entry || !sessionId) return null;
  if (entry.sessionId !== sessionId || entry.cardDismissed) return null;
  return entry.payload;
}

/** Whether the user has already opened this session's canvas in Simulator. */
export function deriveCanvasOpenedInSimulator(
  entry: CanvasPreviewEntry | null,
  sessionId: string | null | undefined
): boolean {
  return Boolean(
    entry && entry.sessionId === sessionId && entry.openedInSimulator
  );
}

/** Payload for an open canvas tab (ignores cardDismissed). */
export function deriveCanvasTabPayload(
  entry: CanvasPreviewEntry | null,
  sessionId: string
): CanvasInlinePayload | null {
  if (!entry || entry.sessionId !== sessionId) return null;
  return entry.payload;
}
