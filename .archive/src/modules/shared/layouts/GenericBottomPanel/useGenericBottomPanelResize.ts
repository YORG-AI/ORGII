/**
 * useGenericBottomPanelResize Hook
 *
 * Pure DOM resize logic for the generic bottom panel.
 * Zero React renders during drag — commits height on mouseup only.
 */
import React, { useCallback, useEffect, useRef } from "react";

interface UseGenericBottomPanelResizeOptions {
  height: number;
  onHeightChange: (height: number) => void;
  minHeight?: number;
  maxHeight?: number;
}

const DEFAULT_MIN_HEIGHT = 120;
const DEFAULT_MAX_HEIGHT = 600;

export function useGenericBottomPanelResize({
  height,
  onHeightChange,
  minHeight = DEFAULT_MIN_HEIGHT,
  maxHeight = DEFAULT_MAX_HEIGHT,
}: UseGenericBottomPanelResizeOptions) {
  const panelRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const pendingHeightRef = useRef<number>(0);
  const isResizingRef = useRef<boolean>(false);
  const hasDraggedRef = useRef<boolean>(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  const handleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();

      if (event.detail >= 2) return;
      if (isResizingRef.current) return;
      isResizingRef.current = true;
      hasDraggedRef.current = false;

      const startY = event.clientY;
      const startHeight = height;
      pendingHeightRef.current = startHeight;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!hasDraggedRef.current) {
          hasDraggedRef.current = true;
          document.body.style.cursor = "row-resize";
          document.body.style.userSelect = "none";
        }

        const delta = startY - moveEvent.clientY;
        const newHeight = Math.max(
          minHeight,
          Math.min(maxHeight, startHeight + delta)
        );
        pendingHeightRef.current = newHeight;

        if (rafRef.current) cancelAnimationFrame(rafRef.current);

        rafRef.current = requestAnimationFrame(() => {
          if (panelRef.current) {
            panelRef.current.style.height = `${newHeight}px`;
          }
        });
      };

      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);

        if (hasDraggedRef.current) {
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          if (panelRef.current) panelRef.current.style.height = "";
          onHeightChange(pendingHeightRef.current);
        }
        isResizingRef.current = false;
      };

      dragCleanupRef.current = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        if (hasDraggedRef.current) {
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        }
        isResizingRef.current = false;
      };
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [height, onHeightChange, minHeight, maxHeight]
  );

  return { panelRef, handleMouseDown };
}
