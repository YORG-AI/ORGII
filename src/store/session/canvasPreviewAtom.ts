/**
 * canvasPreviewAtom — stores the latest canvas payload emitted by the agent
 * via `render_inline_canvas`. Set by `openInSimulatorCanvas` in toolHandlers.
 *
 * - In WorkStation Build panel (SimulatorMessages), the payload is forwarded
 *   to MessageViewer as `canvasPayload` and rendered inline at the end of
 *   the message stream.
 * - In the main Chat panel (ChatView), it is rendered via
 *   `useCanvasForTurn` directly above the InputArea.
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

export const canvasPreviewAtom = atom<CanvasPreviewEntry | null>(null);
canvasPreviewAtom.debugLabel = "session/canvasPreview";
