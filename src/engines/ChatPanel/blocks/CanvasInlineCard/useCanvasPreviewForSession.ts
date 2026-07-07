/**
 * useCanvasPreviewForSession — thin compatibility shim over useCanvasForTurn.
 *
 * New code should call useCanvasForTurn directly; this wrapper preserves the
 * existing interface so callers (ChatVariant, PinnedActionsBar) can migrate
 * gradually without a forced simultaneous change.
 */
import type { CanvasForTurnState } from "./useCanvasForTurn";
import { useCanvasForTurn } from "./useCanvasForTurn";

export type CanvasPreviewForSessionState = CanvasForTurnState;

export function useCanvasPreviewForSession(
  sessionId: string | null | undefined
): CanvasPreviewForSessionState {
  return useCanvasForTurn(sessionId);
}
