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
 *   the user has not dismissed the card. This mirrors the previous guard in
 *   `useCanvasPreviewForSession`, but consolidates it here so every caller
 *   gets the same derived view without duplicating the session-check logic.
 * - `dismiss` soft-hides the card (sets `cardDismissed: true`) so the Canvas
 *   pill reappears in PinnedActionsBar without losing the payload.
 * - `clearCanvas` fully removes the entry (e.g. explicit pill clear).
 * - `openedInSimulator` is surfaced so callers can hide the jump-to-simulator
 *   button once the user has already opened the canvas there.
 */
import { useAtom } from "jotai";
import { useCallback } from "react";

import { canvasPreviewAtom } from "@src/store/session/canvasPreviewAtom";

import {
  applyDismissCanvasEntry,
  deriveCanvasOpenedInSimulator,
  deriveCanvasPayloadForSession,
} from "./canvasPreviewAtomUpdaters";
import type { CanvasInlinePayload } from "./types";

export interface CanvasForTurnState {
  /** Non-null when a canvas is ready and not dismissed for this session. */
  payload: CanvasInlinePayload | null;
  /** True when the user has already jumped to the Simulator canvas view. */
  openedInSimulator: boolean;
  /** Soft-dismiss — hides card, shows Canvas pill in PinnedActionsBar. */
  dismiss: () => void;
  /** Hard-clear — removes the atom entry entirely (e.g. explicit pill clear). */
  clearCanvas: () => void;
}

export function useCanvasForTurn(
  sessionId: string | null | undefined
): CanvasForTurnState {
  const [entry, setEntry] = useAtom(canvasPreviewAtom);

  const payload = deriveCanvasPayloadForSession(entry, sessionId);
  const openedInSimulator = deriveCanvasOpenedInSimulator(entry, sessionId);

  const dismiss = useCallback(() => {
    setEntry(applyDismissCanvasEntry);
  }, [setEntry]);

  const clearCanvas = useCallback(() => {
    setEntry(null);
  }, [setEntry]);

  return { payload, openedInSimulator, dismiss, clearCanvas };
}
