import React from "react";
import { createPortal } from "react-dom";

export interface ReferenceDragState {
  isDragging: boolean;
  dragX: number;
  dragY: number;
  dragLabel: string;
  /** Icon of the row being dragged, so the ghost reads as that row. */
  dragIcon?: React.ReactNode;
  /** Second line — owner, repo, whatever identifies the row. */
  dragSubtitle?: string;
}

interface ReferenceDragGhostProps {
  dragState: ReferenceDragState;
}

/**
 * The dragged row's stand-in. It mirrors the row itself — icon, title and
 * a second identifying line — rather than showing a bare text chip, so the
 * gesture reads as "carrying this session" the whole way to the drop.
 */
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
        top: dragState.dragY - 16,
        pointerEvents: "none",
        zIndex: 99999,
        willChange: "transform",
      }}
    >
      <div className="flex max-w-[260px] items-center gap-2 rounded-lg bg-bg-2 px-2.5 py-1.5 shadow-lg ring-1 ring-border-1">
        {dragState.dragIcon ? (
          <span className="flex shrink-0 items-center text-text-2">
            {dragState.dragIcon}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[12px] font-medium leading-tight text-text-1">
            {dragState.dragLabel}
          </span>
          {dragState.dragSubtitle ? (
            <span className="truncate text-[11px] leading-tight text-text-3">
              {dragState.dragSubtitle}
            </span>
          ) : null}
        </span>
      </div>
    </div>,
    document.body
  );
};
