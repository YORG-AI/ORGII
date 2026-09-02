/**
 * StationDockChrome
 *
 * Shared bottom chrome for Workstation My Station and Agent Station (simulator):
 * centered dock column; with auto-hide, iPhone-style home pill below (hidden when
 * auto-hide is off). Hover/focus uses full-width layout plus extra
 * horizontal padding when auto-hide is on for a wider open trigger; when
 * collapsed, the hidden dock does not reserve width so the strip matches the
 * pill row (plus its horizontal padding).
 *
 * Pointer hover uses a short debounce so moving through the strip does not expand
 * the dock; dwelling opens it. Leaving uses a short delay before collapsing so
 * edge movement does not flicker. When expanded, the pill row collapses in layout
 * (no gap under the dock); a transparent absolutely positioned strip below the
 * dock preserves the bottom hover target. Keyboard focus opens immediately (no
 * debounce).
 */
import React, { memo, useCallback, useEffect, useRef, useState } from "react";

import {
  SIMULATOR_POINTER_HOVER_CLOSE_DELAY_MS,
  SIMULATOR_POINTER_HOVER_OPEN_DEBOUNCE_MS,
} from "@src/engines/Simulator/constants/simulatorPointerHover";
import { GENERAL_LAYOUT_TOUR_TARGETS } from "@src/scaffold/Tutorials/generalLayoutTourConfig";
import { classNames } from "@src/util/ui/classNames";

export interface StationDockChromeProps {
  /** When true, dock collapses to the pill until hover/focus within the strip. */
  autoHide: boolean;
  /** Dock body — e.g. Dock or DockReplayControl. */
  children: React.ReactNode;
  /** Extra classes on the outer wrapper (e.g. border from parent layout). */
  className?: string;
  /** When true, omit vertical padding so tool content can sit flush above the dock. */
  flush?: boolean;
  /** Whether to render the divider line above the dock when visible. */
  showTopBorder?: boolean;
}

export const StationDockChrome: React.FC<StationDockChromeProps> = memo(
  ({ autoHide, children, className, flush = false, showTopBorder = true }) => {
    const [openByPointer, setOpenByPointer] = useState(false);
    const [focusInside, setFocusInside] = useState(false);
    const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearOpenTimer = useCallback(() => {
      if (openTimerRef.current != null) {
        clearTimeout(openTimerRef.current);
        openTimerRef.current = null;
      }
    }, []);

    const clearCloseTimer = useCallback(() => {
      if (closeTimerRef.current != null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    }, []);

    useEffect(() => {
      return () => {
        clearOpenTimer();
        clearCloseTimer();
      };
    }, [clearOpenTimer, clearCloseTimer]);

    const handlePointerEnter = useCallback(() => {
      if (!autoHide) return;
      clearCloseTimer();
      clearOpenTimer();
      openTimerRef.current = setTimeout(() => {
        openTimerRef.current = null;
        setOpenByPointer(true);
      }, SIMULATOR_POINTER_HOVER_OPEN_DEBOUNCE_MS);
    }, [autoHide, clearCloseTimer, clearOpenTimer]);

    const handlePointerLeave = useCallback(() => {
      if (!autoHide) return;
      clearOpenTimer();
      clearCloseTimer();
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        setOpenByPointer(false);
      }, SIMULATOR_POINTER_HOVER_CLOSE_DELAY_MS);
    }, [autoHide, clearCloseTimer, clearOpenTimer]);

    const handleFocusCapture = useCallback(() => {
      if (!autoHide) return;
      setFocusInside(true);
    }, [autoHide]);

    const handleBlurCapture = useCallback(
      (event: React.FocusEvent<HTMLDivElement>) => {
        if (!autoHide) return;
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        setFocusInside(false);
      },
      [autoHide]
    );

    const expanded = !autoHide || openByPointer || focusInside;

    // Fix the expanded dock body to a single 48px row so My Station's
    // pure-icon `Dock` and Agent Station's `DockReplayControl` (which can
    // grow with subagent / overflow / agent-working trailers) both end up
    // exactly the same chrome height. Without this, intrinsic content
    // height drifts by ~1–4px between the two surfaces depending on which
    // trailers render.
    const dockBodyClass = autoHide
      ? classNames(
          "flex w-full items-center justify-center overflow-hidden transition-[max-height,opacity] duration-300 ease-out",
          expanded ? "h-12 opacity-100" : "pointer-events-none h-0 opacity-0"
        )
      : "flex h-12 w-full items-center justify-center";

    const homePillRowClass = autoHide
      ? classNames(
          "flex shrink-0 justify-center overflow-hidden transition-[max-height,opacity,padding] duration-200 ease-out",
          expanded
            ? "pointer-events-none max-h-0 py-0 opacity-0"
            : "px-10 py-1.5 opacity-100"
        )
      : "";

    // Chrome owns the divider line above the dock so every caller — My
    // Station's `<StatusBarRenderer />` + `Dock`, Agent Station's
    // Status bars and replay controls own their own border rhythm, so status-bar-hidden
    // mode, autoHide-collapsed mode — gets the exact same 1px hairline at
    // the exact same DOM depth. Previously each surface drew its own
    // border (BaseStatusBar.border-b, AppShell content fallback border-b,
    // SimulatorSingleView.border-b), and the line drifted by 1px or
    // changed token whenever the path differed. When dock is fully
    // hidden (autoHide && !expanded), suppress the line so it doesn't
    // float above an invisible dock.
    const renderTopBorder = showTopBorder && (!autoHide || expanded);

    return (
      <div
        className={classNames(
          "flex w-full min-w-0 shrink-0 flex-col items-center overflow-visible px-3",
          flush ? "py-0" : "py-0.5",
          renderTopBorder && "border-t border-border-2",
          className
        )}
      >
        <div
          className={classNames(
            "mx-auto flex w-full flex-col items-center",
            autoHide && expanded && "relative"
          )}
          onMouseEnter={handlePointerEnter}
          onMouseLeave={handlePointerLeave}
          onFocusCapture={handleFocusCapture}
          data-tour-target={GENERAL_LAYOUT_TOUR_TARGETS.dock}
          onBlurCapture={handleBlurCapture}
        >
          <div className={dockBodyClass}>{children}</div>
          {autoHide && (
            <div className={homePillRowClass}>
              <div className="pointer-events-none h-[6px] w-[134px] max-w-[min(134px,calc(100vw-120px))] shrink-0 rounded-full bg-fill-3 shadow-[0_0_0_1px_rgba(0,0,0,0.18)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.14)]" />
            </div>
          )}
          {autoHide && expanded && (
            <div
              className="pointer-events-auto absolute top-full left-1/2 z-10 h-[18px] w-[min(240px,calc(100vw-120px))] -translate-x-1/2"
              aria-hidden
            />
          )}
        </div>
      </div>
    );
  }
);

StationDockChrome.displayName = "StationDockChrome";
