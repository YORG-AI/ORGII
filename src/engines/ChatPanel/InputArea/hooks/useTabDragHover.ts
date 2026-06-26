import { type RefObject, useEffect, useState } from "react";

import { isWorkstationTabDragActive } from "@src/shared/dnd/dragSideChannel";

/**
 * Tracks whether a WorkStation tab is being dragged over a given drop-target
 * element using pointer events (dnd-kit does not fire HTML5 drag events).
 *
 * Listens on `document` for `pointermove` while
 * `window.__internalWorkstationTabDrag` is true and checks if the pointer
 * intersects the element's bounding rect. Clears state on `tab-drag-end`.
 */
export function useTabDragHover(
  targetRef: RefObject<HTMLElement | null>
): boolean {
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    let rafId: number | null = null;

    const checkHover = (x: number, y: number) => {
      const el = targetRef.current?.matches("[data-chat-drop-target]")
        ? targetRef.current
        : targetRef.current?.querySelector<HTMLElement>(
            "[data-chat-drop-target]"
          );

      if (!el) {
        setIsDragOver(false);
        return;
      }

      const rect = el.getBoundingClientRect();
      const over =
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      setIsDragOver(over);
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (!isWorkstationTabDragActive()) return;

      const { clientX, clientY } = e;
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          checkHover(clientX, clientY);
        });
      }
    };

    const handleDragEnd = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      setIsDragOver(false);
    };

    document.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    document.addEventListener("tab-drag-end", handleDragEnd);

    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("tab-drag-end", handleDragEnd);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [targetRef]);

  return isDragOver;
}
