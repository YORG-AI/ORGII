/**
 * ProgressRing
 *
 * Circular SVG progress indicator rendered in the ContextInfoButton toolbar
 * trigger. Fills clockwise from the top with a smooth CSS transition.
 * Color tone distinguishes empty context from used context.
 */
import { memo } from "react";

import {
  RING_CIRCUMFERENCE,
  RING_RADIUS,
  RING_SIZE,
  RING_STROKE,
  RING_TONE_STROKE,
  type RingTone,
} from "./contextInfoTypes";

export interface ProgressRingProps {
  percentage: number;
  tone?: RingTone;
}

const ProgressRing = memo(
  ({ percentage, tone = "unused" }: ProgressRingProps) => {
    const filled = (Math.min(percentage, 100) / 100) * RING_CIRCUMFERENCE;
    const gap = RING_CIRCUMFERENCE - filled;
    const strokeClass = RING_TONE_STROKE[tone] ?? "stroke-text-4";

    return (
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        className="shrink-0"
      >
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          className="stroke-text-4"
          strokeWidth={RING_STROKE}
        />
        {filled > 0 && (
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            className={strokeClass}
            strokeWidth={RING_STROKE}
            strokeDasharray={`${filled} ${gap}`}
            strokeDashoffset={RING_CIRCUMFERENCE / 4}
            strokeLinecap="round"
            style={{ transition: "stroke-dasharray 0.3s ease" }}
          />
        )}
      </svg>
    );
  }
);

ProgressRing.displayName = "ProgressRing";

export default ProgressRing;
