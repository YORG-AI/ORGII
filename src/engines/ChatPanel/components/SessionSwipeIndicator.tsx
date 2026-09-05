/**
 * Edge pill that surfaces while a two-finger swipe builds toward Back or
 * Forward: it slides in from the pane edge, widens, and goes from
 * semi-transparent to solid as the gesture approaches the trigger distance.
 */
import React, { memo } from "react";

import { ArrowLeft01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";

import type { SessionSwipeIndicatorState } from "../hooks/useSessionSwipeNavigation";

const MIN_WIDTH_PX = 22;
const MAX_WIDTH_PX = 46;
const HEIGHT_PX = 72;
const MIN_OPACITY = 0.35;

export const SessionSwipeIndicator: React.FC<SessionSwipeIndicatorState> = memo(
  ({ direction, progress }) => {
    if (!direction || progress <= 0) return null;
    const isBack = direction === "back";
    const width = MIN_WIDTH_PX + (MAX_WIDTH_PX - MIN_WIDTH_PX) * progress;
    const opacity = MIN_OPACITY + (1 - MIN_OPACITY) * progress;
    // Slide the last few pixels in as the pill lights up.
    const slide = (1 - progress) * 6;

    return (
      <div
        aria-hidden
        data-testid="session-swipe-indicator"
        data-direction={direction}
        className={`pointer-events-none absolute top-1/2 z-40 flex items-center justify-center bg-primary-6 text-white shadow-md transition-[width,opacity,transform] duration-75 ease-out ${
          isBack ? "left-0 rounded-r-xl" : "right-0 rounded-l-xl"
        }`}
        style={{
          width,
          height: HEIGHT_PX,
          opacity,
          transform: `translateY(-50%) translateX(${isBack ? -slide : slide}px)`,
        }}
      >
        <HugeiconsIcon
          icon={isBack ? ArrowLeft01Icon : ArrowRight01Icon}
          data-icon={isBack ? "arrow-left" : "arrow-right"}
          size={18}
          strokeWidth={2.25}
        />
      </div>
    );
  }
);

SessionSwipeIndicator.displayName = "SessionSwipeIndicator";
