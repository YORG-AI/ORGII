/**
 * useCanvasForTurn — canonical canvas state hook.
 *
 * Single entry-point for all canvas UI state in the chat panel. Returns the
 * canvas payload for the active session alongside stable action callbacks for
 * dismiss and clear. Replaces ad-hoc reads of `canvasPreviewAtom` sprinkled
 * across components.
 *
 * Design:
 * - Payload is only returned when `sessionId` matches the stored entry AND
 *   the user has not dismissed the card. Every caller receives the same
 *   derived view instead of duplicating the session-check logic.
 * - `dismiss` soft-hides the card (sets `cardDismissed: true`) so the Canvas
 *   pill reappears in PinnedActionsBar without losing the payload.
 * - `clearCanvas` fully removes the entry (used when the tab is closed).
 * - `openedInSimulator` is surfaced so callers can hide the jump-to-simulator
 *   button once the user has already opened the canvas there.
 */
import { useAtom } from "jotai";
import { useCallback } from "react";

import {
  type CanvasForSessionSnapshot,
  type CanvasPreviewEntry,
  canvasPreviewAtom,
  clearCanvasForSession,
  deriveCanvasForSessionSnapshot,
  dismissCanvasForSession,
} from "@src/store/session/canvasPreviewAtom";

export interface CanvasForTurnSnapshot extends CanvasForSessionSnapshot {
  /** Whether a snapshot-derived latest-canvas shortcut may be shown. */
  allowsLatestCanvasShortcut: boolean;
}

export function deriveCanvasForTurnSnapshot(
  entry: CanvasPreviewEntry | null,
  sessionId: string | null | undefined
): CanvasForTurnSnapshot {
  const sessionSnapshot = deriveCanvasForSessionSnapshot(entry, sessionId);
  return {
    ...sessionSnapshot,
    allowsLatestCanvasShortcut:
      !sessionSnapshot.isDismissed && !sessionSnapshot.openedInSimulator,
  };
}

export interface CanvasForTurnState {
  snapshot: CanvasForTurnSnapshot;
  /** Soft-dismiss — hides card, shows Canvas pill in PinnedActionsBar. */
  dismiss: () => void;
  /** Hard-clear — removes the atom entry entirely (e.g. on tab close). */
  clearCanvas: () => void;
}

export function useCanvasForTurn(
  sessionId: string | null | undefined
): CanvasForTurnState {
  const [entry, setEntry] = useAtom(canvasPreviewAtom);
  const snapshot = deriveCanvasForTurnSnapshot(entry, sessionId);

  const dismiss = useCallback(() => {
    setEntry((prev) => dismissCanvasForSession(prev, sessionId));
  }, [sessionId, setEntry]);

  const clearCanvas = useCallback(() => {
    setEntry((prev) => clearCanvasForSession(prev, sessionId));
  }, [sessionId, setEntry]);

  return { snapshot, dismiss, clearCanvas };
}
