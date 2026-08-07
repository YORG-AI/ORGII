/**
 * canvasPreviewAtom — stores the latest canvas payload emitted by the agent
 * via `render_inline_canvas`. Set by `openInSimulatorCanvas` in toolHandlers.
 *
 * - In WorkStation Build panel (SimulatorMessages), the payload is forwarded
 *   to MessageViewer as `canvasPayload` and rendered inline at the end of
 *   the message stream.
 * - UI consumers derive session-scoped state and actions through
 *   `useCanvasForTurn`.
 *
 * Cleared when the user closes the card or the session resets.
 */
import { atom } from "jotai";

import type { CanvasInlinePayload } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/types";

export interface CanvasPreviewEntry {
  sessionId: string;
  payload: CanvasInlinePayload;
  cardDismissed?: boolean;
  openedInSimulator?: boolean;
}

export interface CanvasForSessionSnapshot {
  /** Latest stored payload for this session, including a dismissed canvas. */
  latestPayload: CanvasInlinePayload | null;
  /** Payload that should still render as an inline card. */
  payload: CanvasInlinePayload | null;
  /** True when the inline card was dismissed into PinnedActionsBar. */
  isDismissed: boolean;
  /** True when the canvas was already opened in the Simulator canvas app. */
  openedInSimulator: boolean;
}

export function deriveCanvasForSessionSnapshot(
  entry: CanvasPreviewEntry | null,
  sessionId: string | null | undefined
): CanvasForSessionSnapshot {
  const matchingEntry =
    sessionId && entry?.sessionId === sessionId ? entry : null;
  const latestPayload = matchingEntry?.payload ?? null;
  const isDismissed = Boolean(matchingEntry?.cardDismissed);
  const openedInSimulator = Boolean(matchingEntry?.openedInSimulator);

  return {
    latestPayload,
    payload: isDismissed ? null : latestPayload,
    isDismissed,
    openedInSimulator,
  };
}

export function dismissCanvasForSession(
  entry: CanvasPreviewEntry | null,
  sessionId: string | null | undefined
): CanvasPreviewEntry | null {
  if (!sessionId || entry?.sessionId !== sessionId || entry.cardDismissed) {
    return entry;
  }
  return { ...entry, cardDismissed: true };
}

export function clearCanvasForSession(
  entry: CanvasPreviewEntry | null,
  sessionId: string | null | undefined
): CanvasPreviewEntry | null {
  return sessionId && entry?.sessionId === sessionId ? null : entry;
}

export const canvasPreviewAtom = atom<CanvasPreviewEntry | null>(null);
canvasPreviewAtom.debugLabel = "session/canvasPreview";
