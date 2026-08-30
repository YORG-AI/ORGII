/**
 * DetailPanelHeader Component
 *
 * Header for detail panels with title, navigation (prev/next), close, and optional actions.
 * Uses shared WorkStation header tokens for consistent styling.
 */
import React from "react";

import {
  HEADER_BUTTON,
  HEADER_CLASSES,
  HEADER_ICON_SIZE,
} from "@src/config/workstation/tokens";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  HugeiconsIcon,
} from "@src/icons";

import { useWindowDrag } from "../FloatingWindow/useWindowDrag";

export interface DetailPanelHeaderProps {
  /** Title to display */
  title: string;
  /** Callback when close button is clicked */
  onClose: () => void;
  /** Optional navigation callback */
  onNavigate?: (direction: "prev" | "next") => void;
  /** Whether previous navigation is available */
  hasPrev?: boolean;
  /** Whether next navigation is available */
  hasNext?: boolean;
  /** Optional extra actions rendered before the nav/close buttons */
  actions?: React.ReactNode;
  /**
   * When true, dragging the header repositions the nearest
   * `[data-draggable-window]` ancestor, and the header drops its bottom
   * border so the floating window reads as one continuous surface. Used by
   * the floating windows (Kanban session preview, side chat); docked panels
   * leave this off.
   */
  draggable?: boolean;
}

const DetailPanelHeader: React.FC<DetailPanelHeaderProps> = ({
  title,
  onClose,
  onNavigate,
  hasPrev = false,
  hasNext = false,
  actions,
  draggable = false,
}) => {
  const onPointerDown = useWindowDrag(draggable);
  return (
    <div
      className={
        draggable
          ? `${HEADER_CLASSES.pageHeader} cursor-grab select-none !border-b-0`
          : HEADER_CLASSES.pageHeader
      }
      onPointerDown={onPointerDown}
    >
      <div className="flex min-w-0 flex-1 items-center">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-1">
          {title}
        </span>
      </div>

      <div className="flex flex-shrink-0 items-center gap-1.5">
        {actions}
        {actions && (
          <span aria-hidden className="h-4 w-px flex-shrink-0 bg-border-2" />
        )}
        {onNavigate && (
          <>
            <button
              className={HEADER_BUTTON.actionDisabled}
              onClick={() => onNavigate("prev")}
              disabled={!hasPrev}
              title="Previous"
            >
              <HugeiconsIcon
                icon={ArrowUp01Icon}
                data-icon="chevron-up"
                size={HEADER_ICON_SIZE.sm}
              />
            </button>
            <button
              className={HEADER_BUTTON.actionDisabled}
              onClick={() => onNavigate("next")}
              disabled={!hasNext}
              title="Next"
            >
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                data-icon="chevron-down"
                size={HEADER_ICON_SIZE.sm}
              />
            </button>
          </>
        )}
        <button
          className={HEADER_BUTTON.action}
          onClick={onClose}
          title="Close"
        >
          <HugeiconsIcon
            icon={Cancel01Icon}
            data-icon="x"
            size={HEADER_ICON_SIZE.sm}
          />
        </button>
      </div>
    </div>
  );
};

export default DetailPanelHeader;
