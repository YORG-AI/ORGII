/**
 * useWindowDrag
 *
 * Makes a floating panel draggable by a handle (its header). Spread the
 * returned `onPointerDown` on the handle element; the moved element is the
 * nearest ancestor carrying `data-draggable-window`.
 *
 * The transform is applied imperatively to that ancestor's `style`, so a drag
 * never re-renders the React tree — only one element's `transform` changes.
 * The accumulated offset lives on the window element itself (see
 * `windowGeometry.ts`), so the position survives re-renders and header
 * remounts, and resets naturally when the panel unmounts and re-opens.
 *
 * No-op when `enabled` is false or the handle has no `[data-draggable-window]`
 * ancestor, so the same header stays inert on docked (non-floating) panels.
 */
import { useCallback, useEffect, useRef } from "react";

import {
  applyWindowOffset,
  clamp,
  findFloatingWindow,
  readWindowBounds,
  readWindowOffset,
} from "./windowGeometry";

const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, [role="button"], [data-no-window-drag]';

export function useWindowDrag(enabled: boolean) {
  const cleanupRef = useRef<(() => void) | null>(null);

  // Tear down listeners / restore the cursor if the panel unmounts mid-drag.
  useEffect(() => () => cleanupRef.current?.(), []);

  return useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) {
        return;
      }

      const win = findFloatingWindow(event.currentTarget);
      if (!win) return;

      const bounds = readWindowBounds(win);
      const rect = win.getBoundingClientRect();
      const start = readWindowOffset(win);
      // Untransformed origin of the window, so clamps read in viewport space.
      const baseLeft = rect.left - start.x;
      const baseTop = rect.top - start.y;
      const startX = event.clientX;
      const startY = event.clientY;

      const handleMove = (moveEvent: PointerEvent) => {
        let nextX = start.x + (moveEvent.clientX - startX);
        let nextY = start.y + (moveEvent.clientY - startY);
        if (bounds) {
          // Keep the whole window inside its overlay's content box, so it
          // can never be dragged out of sight or over the edge margin.
          nextX = clamp(
            nextX,
            bounds.left - baseLeft,
            bounds.right - rect.width - baseLeft
          );
          nextY = clamp(
            nextY,
            bounds.top - baseTop,
            bounds.bottom - rect.height - baseTop
          );
        }
        applyWindowOffset(win, { x: nextX, y: nextY });
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
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    },
    [enabled]
  );
}
