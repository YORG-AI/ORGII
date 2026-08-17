/**
 * FloatingWindow
 *
 * Shared shell for floating in-pane windows (kanban session preview, chat
 * pane side chat): a `pointer-events-none` overlay that defines the drag /
 * resize bounds, plus a `data-draggable-window` surface inside it.
 *
 * - Dragging: give the window a header that spreads `useWindowDrag`'s
 *   handler (e.g. `<DetailPanelHeader draggable>`); the surface carries the
 *   `data-draggable-window` marker the hook looks for.
 * - Resizing: enabled by default via invisible edge/corner handles. The
 *   first resize pins the surface to explicit px geometry; before that it
 *   follows whatever fluid CSS the caller's `surfaceClassName` sets up.
 * - When the overlay itself resizes (app window, split-panel drag), a
 *   pinned surface is re-fitted so it can never be stranded off-screen.
 *
 * Callers own the look: pass the overlay class (positioning context, e.g.
 * `WORK_MANAGEMENT_SESSION_PREVIEW_OVERLAY_CLASS`) and the surface class
 * (initial size/anchor + chrome). The overlay must remain the surface's
 * direct parent — both hooks clamp against it.
 */
import React, { useEffect, useRef } from "react";

import FloatingWindowResizeHandles from "./ResizeHandles";
import { fitPinnedWindow } from "./windowGeometry";

const DEFAULT_MIN_WIDTH = 360;
const DEFAULT_MIN_HEIGHT = 240;

export interface FloatingWindowProps {
  /** Positioning context + anchoring for the window (pointer-events-none). */
  overlayClassName: string;
  /** Initial fluid geometry + chrome of the window surface itself. */
  surfaceClassName: string;
  /** Turn off the edge/corner resize handles (drag-only window). */
  resizable?: boolean;
  minWidth?: number;
  minHeight?: number;
  /** Optional px resize caps; the overlay bounds always apply on top. */
  maxWidth?: number;
  maxHeight?: number;
  children: React.ReactNode;
}

const FloatingWindow: React.FC<FloatingWindowProps> = ({
  overlayClassName,
  surfaceClassName,
  resizable = true,
  minWidth = DEFAULT_MIN_WIDTH,
  minHeight = DEFAULT_MIN_HEIGHT,
  maxWidth,
  maxHeight,
  children,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!resizable) return;
    const overlay = overlayRef.current;
    const surface = surfaceRef.current;
    if (!overlay || !surface) return;
    const observer = new ResizeObserver(() => {
      fitPinnedWindow(surface, minWidth, minHeight);
    });
    observer.observe(overlay);
    return () => observer.disconnect();
  }, [minHeight, minWidth, resizable]);

  return (
    <div ref={overlayRef} className={overlayClassName}>
      <div
        ref={surfaceRef}
        // `relative` anchors the edge/corner resize handles to the surface
        // (the overlay is the nearest positioned ancestor otherwise, and
        // `overflow-hidden` would clip the handles into dead zones).
        className={`relative ${surfaceClassName}`}
        data-draggable-window
      >
        {children}
        {resizable && (
          <FloatingWindowResizeHandles
            minWidth={minWidth}
            minHeight={minHeight}
            maxWidth={maxWidth}
            maxHeight={maxHeight}
          />
        )}
      </div>
    </div>
  );
};

export default FloatingWindow;
