/**
 * useChatViewCanvasPreview
 *
 * Derives the composer's "Canvas" shortcut pill from the current turn's
 * canvas payload (preferring the live in-turn canvas over the session's
 * last-known preview) and the jump-to-simulator-canvas handler.
 */
import { useMemo } from "react";

import type { Snapshot } from "@src/engines/SessionCore/core/store/EventStoreProxy";

import { useCanvasForTurn } from "../blocks/CanvasInlineCard/useCanvasForTurn";
import { useJumpToSimulatorCanvas } from "../blocks/CanvasInlineCard/useJumpToSimulatorCanvas";

export function useChatViewCanvasPreview(
  sessionId: string,
  snapshot: Snapshot | null
) {
  const { snapshot: canvasForTurn } = useCanvasForTurn(sessionId);
  const latestCanvasPreview = snapshot?.latestCanvasPreview ?? null;
  const latestCanvasPayload = useMemo(
    () =>
      canvasForTurn.latestPayload
        ? canvasForTurn.latestPayload
        : latestCanvasPreview
          ? {
              mode: latestCanvasPreview.mode,
              url: latestCanvasPreview.url,
              title: latestCanvasPreview.title,
              streaming: latestCanvasPreview.streaming,
              eventId: latestCanvasPreview.eventId,
            }
          : null,
    [canvasForTurn.latestPayload, latestCanvasPreview]
  );
  const openLatestCanvas = useJumpToSimulatorCanvas(
    sessionId,
    latestCanvasPayload
  );
  const canvasPreviewPill = useMemo(
    () =>
      latestCanvasPayload &&
      canvasForTurn.allowsLatestCanvasShortcut &&
      openLatestCanvas
        ? {
            label: "Canvas",
            onOpen: openLatestCanvas,
          }
        : null,
    [
      canvasForTurn.allowsLatestCanvasShortcut,
      latestCanvasPayload,
      openLatestCanvas,
    ]
  );

  return canvasPreviewPill;
}
