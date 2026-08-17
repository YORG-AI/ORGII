/**
 * FloatingWindowResizeHandles
 *
 * Invisible edge/corner hit areas rendered inside a floating window surface
 * (which is `overflow-hidden`, so they sit just inside the border). Corners
 * win over edges by being rendered later at the same z-index tier.
 *
 * `data-no-window-drag` keeps the header drag hook from also claiming the
 * north handle, which overlaps the draggable header strip.
 */
import React from "react";

import { type ResizeEdge, useWindowResize } from "./useWindowResize";

const HANDLES: ReadonlyArray<{ edge: ResizeEdge; className: string }> = [
  { edge: "n", className: "inset-x-2.5 top-0 h-[5px] cursor-ns-resize" },
  { edge: "s", className: "inset-x-2.5 bottom-0 h-[5px] cursor-ns-resize" },
  { edge: "e", className: "inset-y-2.5 right-0 w-[5px] cursor-ew-resize" },
  { edge: "w", className: "inset-y-2.5 left-0 w-[5px] cursor-ew-resize" },
  { edge: "nw", className: "left-0 top-0 h-2.5 w-2.5 cursor-nwse-resize" },
  { edge: "ne", className: "right-0 top-0 h-2.5 w-2.5 cursor-nesw-resize" },
  { edge: "sw", className: "bottom-0 left-0 h-2.5 w-2.5 cursor-nesw-resize" },
  { edge: "se", className: "bottom-0 right-0 h-2.5 w-2.5 cursor-nwse-resize" },
];

export interface FloatingWindowResizeHandlesProps {
  minWidth: number;
  minHeight: number;
  maxWidth?: number;
  maxHeight?: number;
}

const FloatingWindowResizeHandles: React.FC<
  FloatingWindowResizeHandlesProps
> = ({ minWidth, minHeight, maxWidth, maxHeight }) => {
  const startResize = useWindowResize({
    minWidth,
    minHeight,
    maxWidth,
    maxHeight,
  });
  return (
    <>
      {HANDLES.map(({ edge, className }) => (
        <div
          key={edge}
          data-no-window-drag
          onPointerDown={startResize(edge)}
          className={`absolute z-30 touch-none select-none ${className}`}
        />
      ))}
    </>
  );
};

export default FloatingWindowResizeHandles;
