import React from "react";
import { createPortal } from "react-dom";

export interface ReferenceDragState {
  isDragging: boolean;
  dragX: number;
  dragY: number;
  dragLabel: string;
}

interface ReferenceDragGhostProps {
  dragState: ReferenceDragState;
}

export const ReferenceDragGhost: React.FC<ReferenceDragGhostProps> = ({
  dragState,
}) => {
  if (!dragState.isDragging) return null;

  return createPortal(
    <div
      aria-hidden
      style={{
        position: "fixed",
        left: dragState.dragX + 12,
        top: dragState.dragY - 14,
        pointerEvents: "none",
        zIndex: 99999,
        willChange: "transform",
      }}
    >
      <div className="flex items-center gap-1.5 rounded-full bg-bg-2 px-2.5 py-1 text-[12px] font-medium text-text-1 shadow-lg ring-1 ring-border-1">
        <span className="max-w-[180px] truncate">{dragState.dragLabel}</span>
      </div>
    </div>,
    document.body
  );
};
