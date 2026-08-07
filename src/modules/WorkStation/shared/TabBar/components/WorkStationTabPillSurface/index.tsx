import React, { useCallback } from "react";

import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { useImmediateCursorReset } from "@src/hooks/ui/useImmediateCursorReset";

type WorkStationTabPillElement = HTMLButtonElement | HTMLDivElement;

export interface WorkStationTabPillSurfaceProps extends React.HTMLAttributes<WorkStationTabPillElement> {
  as?: "button" | "div";
  isActive: boolean;
  isDragging?: boolean;
  hideLabel?: boolean;
  variant?: "standard" | "compact" | "session";
}

const VARIANT_CLASSES: Record<
  NonNullable<WorkStationTabPillSurfaceProps["variant"]>,
  string
> = {
  standard: "min-w-[3.5rem] max-w-[240px] shrink-0 gap-1.5 px-2.5",
  compact: "h-8 w-8 shrink-0 justify-center",
  session: "min-w-0 max-w-[120px] shrink-0 gap-1.5 px-2.5",
};

export const WORK_STATION_TAB_PILL_DRAG_OVERLAY_CLASS = `flex h-8 shrink-0 cursor-grabbing items-center gap-1.5 rounded-lg border border-border-2 ${SURFACE_TOKENS.selected} pl-2.5 pr-2 shadow-lg`;

export const WorkStationTabPillSurface = React.forwardRef<
  WorkStationTabPillElement,
  WorkStationTabPillSurfaceProps
>(
  (
    {
      as = "div",
      isActive,
      isDragging = false,
      hideLabel = false,
      variant = hideLabel ? "compact" : "standard",
      className = "",
      children,
      onClick,
      onMouseLeave,
      ...props
    },
    ref
  ) => {
    const { cursorReset, markClicked, resetCursor } = useImmediateCursorReset(
      isActive,
      Boolean(onClick)
    );

    const handleClick = useCallback(
      (event: React.MouseEvent<WorkStationTabPillElement>) => {
        markClicked();
        onClick?.(event);
      },
      [markClicked, onClick]
    );

    const handleMouseLeave = useCallback(
      (event: React.MouseEvent<WorkStationTabPillElement>) => {
        resetCursor();
        onMouseLeave?.(event);
      },
      [onMouseLeave, resetCursor]
    );

    const stateClass = isActive
      ? `work-station-editor-tab--active z-10 ${SURFACE_TOKENS.selected} text-primary-6 ${SURFACE_TOKENS.selectedHover}`
      : `bg-transparent text-text-2 ${SURFACE_TOKENS.hover}`;
    const draggingClass = isDragging
      ? `work-station-editor-tab--dragging cursor-grabbing ${SURFACE_TOKENS.selected} opacity-90`
      : "";
    const cursorClass = isDragging
      ? "cursor-grabbing"
      : !isActive && !cursorReset && onClick
        ? "cursor-pointer"
        : "cursor-default";
    const surfaceClassName = `work-station-editor-tab relative flex h-8 min-w-0 ${cursorClass} select-none items-center overflow-hidden rounded-lg transition-colors duration-150 ${VARIANT_CLASSES[variant]} ${stateClass} ${draggingClass} ${className}`;

    if (as === "button") {
      return (
        <button
          ref={ref as React.Ref<HTMLButtonElement>}
          type="button"
          className={surfaceClassName}
          onClick={handleClick as React.MouseEventHandler<HTMLButtonElement>}
          onMouseLeave={
            handleMouseLeave as React.MouseEventHandler<HTMLButtonElement>
          }
          {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        >
          {children}
        </button>
      );
    }

    return (
      <div
        ref={ref as React.Ref<HTMLDivElement>}
        className={surfaceClassName}
        onClick={handleClick as React.MouseEventHandler<HTMLDivElement>}
        onMouseLeave={
          handleMouseLeave as React.MouseEventHandler<HTMLDivElement>
        }
        {...(props as React.HTMLAttributes<HTMLDivElement>)}
      >
        {children}
      </div>
    );
  }
);

WorkStationTabPillSurface.displayName = "WorkStationTabPillSurface";
