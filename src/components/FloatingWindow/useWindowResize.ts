/**
 * useWindowResize
 *
 * Edge/corner resizing for a floating window (the nearest
 * `[data-draggable-window]` ancestor of the handle). Returns a factory:
 * `startResize("se")` gives the pointer-down handler for that handle.
 *
 * The first resize pins the window (explicit absolute px geometry — see
 * `windowGeometry.ts`); from then on each edge moves independently of the
 * window's original CSS centering. Like `useWindowDrag`, all writes go
 * straight to the element's style, so resizing never re-renders React.
 */
import { useCallback, useEffect, useRef } from "react";

import {
  clamp,
  findFloatingWindow,
  pinWindow,
  readWindowBounds,
} from "./windowGeometry";

export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const EDGE_CURSOR: Record<ResizeEdge, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

export interface UseWindowResizeOptions {
  minWidth: number;
  minHeight: number;
  /** Optional px caps; the overlay bounds always apply on top. */
  maxWidth?: number;
  maxHeight?: number;
}

export function useWindowResize({
  minWidth,
  minHeight,
  maxWidth = Number.POSITIVE_INFINITY,
  maxHeight = Number.POSITIVE_INFINITY,
}: UseWindowResizeOptions) {
  const cleanupRef = useRef<(() => void) | null>(null);

  // Tear down listeners / restore the cursor if the panel unmounts mid-resize.
  useEffect(() => () => cleanupRef.current?.(), []);

  return useCallback(
    (edge: ResizeEdge) => (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const win = findFloatingWindow(event.currentTarget);
      if (!win) return;
      const bounds = readWindowBounds(win);
      if (!bounds) return;

      event.preventDefault();
      event.stopPropagation();

      pinWindow(win);
      const startLeft = Number.parseFloat(win.style.left) || 0;
      const startTop = Number.parseFloat(win.style.top) || 0;
      const startWidth = Number.parseFloat(win.style.width) || 0;
      const startHeight = Number.parseFloat(win.style.height) || 0;
      const startX = event.clientX;
      const startY = event.clientY;

      const handleMove = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;

        // The non-dragged edge stays fixed; the window never leaves the
        // overlay's content box (padding = edge margin), mirroring the drag
        // clamps, and never exceeds the configured px caps.
        if (edge.includes("e")) {
          const width = clamp(
            startWidth + dx,
            minWidth,
            Math.min(bounds.maxRight - startLeft, maxWidth)
          );
          win.style.width = `${width}px`;
        } else if (edge.includes("w")) {
          const width = clamp(
            startWidth - dx,
            minWidth,
            Math.min(startLeft + startWidth - bounds.minLeft, maxWidth)
          );
          win.style.width = `${width}px`;
          win.style.left = `${startLeft + startWidth - width}px`;
        }
        if (edge.includes("s")) {
          const height = clamp(
            startHeight + dy,
            minHeight,
            Math.min(bounds.maxBottom - startTop, maxHeight)
          );
          win.style.height = `${height}px`;
        } else if (edge.includes("n")) {
          const height = clamp(
            startHeight - dy,
            minHeight,
            Math.min(startTop + startHeight - bounds.minTop, maxHeight)
          );
          win.style.height = `${height}px`;
          win.style.top = `${startTop + startHeight - height}px`;
        }
      };

      const finish = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        cleanupRef.current = null;
      };

      cleanupRef.current = finish;
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      document.body.style.cursor = EDGE_CURSOR[edge];
      document.body.style.userSelect = "none";
    },
    [minWidth, minHeight, maxWidth, maxHeight]
  );
}
