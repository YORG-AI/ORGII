/**
 * openInSimulatorCanvas — Show a canvas payload in the WorkStation Build panel.
 *
 * Sets canvasPreviewAtom so SimulatorMessages renders the preview inline
 * without crossing any window / iframe boundary. The atom is read by
 * SimulatorMessages and drives a CanvasInlineCard overlay above the message
 * list.
 */
import { canvasPreviewAtom } from "@src/store/session/canvasPreviewAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { isSameLogicalCanvas } from "./canvasRevision";
import type { CanvasInlinePayload } from "./types";

export function openInSimulatorCanvas(
  sessionId: string,
  payload: CanvasInlinePayload,
  options?: { openedInSimulator?: boolean }
): void {
  const store = getInstrumentedStore();
  const previous = store.get(canvasPreviewAtom);
  const sameCanvas =
    previous?.sessionId === sessionId &&
    isSameLogicalCanvas(previous.payload, payload);
  store.set(canvasPreviewAtom, {
    sessionId,
    payload,
    openedInSimulator:
      options?.openedInSimulator ??
      (sameCanvas ? previous?.openedInSimulator : undefined),
  });
}
