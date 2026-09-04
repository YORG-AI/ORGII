/**
 * useChatViewCanvasPreview
 *
 * Derives the composer's "Canvas" shortcut pill from the current turn's
 * canvas payload (preferring the live in-turn canvas over the session's
 * last-known preview) and the jump-to-simulator-canvas handler.
 */
import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useMemo } from "react";

import { sessionSnapshotAtomFamily } from "@src/engines/SessionCore/derived/sessionScopedChatEvents";
import type { SessionSnapshotState } from "@src/engines/SessionCore/derived/sessionScopedChatEvents";

import { useCanvasForTurn } from "../blocks/CanvasInlineCard/useCanvasForTurn";
import { useJumpToSimulatorCanvas } from "../blocks/CanvasInlineCard/useJumpToSimulatorCanvas";

function canvasPreviewEqual(
  left: ReturnType<typeof readLatestCanvasPreview>,
  right: ReturnType<typeof readLatestCanvasPreview>
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.mode === right.mode &&
    left.url === right.url &&
    left.title === right.title &&
    left.streaming === right.streaming &&
    left.eventId === right.eventId
  );
}

function readLatestCanvasPreview(state: SessionSnapshotState) {
  return state.snapshot?.latestCanvasPreview ?? null;
}

export function useChatViewCanvasPreview(sessionId: string) {
  const latestCanvasPreviewAtom = useMemo(
    () =>
      selectAtom(
        sessionSnapshotAtomFamily(sessionId),
        readLatestCanvasPreview,
        canvasPreviewEqual
      ),
    [sessionId]
  );
  const latestCanvasPreview = useAtomValue(latestCanvasPreviewAtom);
  const { snapshot: canvasForTurn } = useCanvasForTurn(sessionId);
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
