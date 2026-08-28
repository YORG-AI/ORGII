/**
 * ReplayProgressBar
 *
 * Generic, props-driven music-player-style scrub bar. Originally lifted
 * from `MusicPlayerReplayBar` (Simulator dock) and `KanbanReplayBar`
 * (Kanban canvas) which were near-identical copies — index-based vs
 * timestamp-based mapping was the only real difference, and that
 * mapping belongs to the *caller*, not the bar itself.
 *
 * The caller is responsible for:
 *   - Computing `value` in the shared [0, max] slider space.
 *   - Mapping `value` back to its own domain (event index, timestamp,
 *     etc.) inside `onValueChange` / `onValueCommit`.
 *   - Telling the bar whether it's currently in `follow` mode (the
 *     playhead is pinned to the right edge, drag handle hidden).
 *
 * Visual contract: the rail's TOP edge is pixel-stable. Both the 1px
 * rail and the 2px track are anchored at top:0, with the extra 1px of
 * the track only extending downward. The left/right edge caps preserve
 * the same top-aligned thin/thick contrast even when the slider hits
 * its endpoints.
 */
import React, { memo } from "react";

import Slider from "@src/components/Slider";

import ReplayTurnTimeline from "./ReplayTurnTimeline";
import "./index.scss";
import type { ReplayProgressSegment } from "./types";

export interface ReplayProgressBarProps {
  /** Current slider position in [0, max]. */
  value: number;
  /** Slider's maximum value (the [0, max] domain). */
  max: number;
  /** Fired continuously while dragging. */
  onValueChange: (value: number | number[]) => void;
  /** Fired when the interaction commits (pointer release or keyboard step). */
  onValueCommit: (value: number | number[]) => void;
  /** True when the cursor is pinned to "follow latest" — hides drag handle. */
  isFollowMode: boolean;
  /** Disables interaction (e.g. no events to scrub through). */
  disabled?: boolean;
  /** ARIA label, since this bar acts as a slider. */
  ariaLabel?: string;
  /** Optional extra class for the root (e.g. for caller-specific z-index). */
  className?: string;
  /** Turn bands rendered beneath the scrubber rail. */
  segments?: readonly ReplayProgressSegment[];
  /** Seek to the start of a turn band. */
  onSegmentClick?: (segment: ReplayProgressSegment) => void;
}

const ReplayProgressBar: React.FC<ReplayProgressBarProps> = memo(
  ({
    value,
    max,
    onValueChange,
    onValueCommit,
    isFollowMode,
    disabled = false,
    ariaLabel,
    className,
    segments,
    onSegmentClick,
  }) => {
    const showSegments = segments && segments.length > 1;

    return (
      <div
        className={`replay-progress-bar relative z-40 w-full overflow-visible ${showSegments ? "replay-progress-bar--segmented" : ""} ${className ?? ""}`}
        role="group"
        aria-label={ariaLabel}
        data-follow-mode={isFollowMode ? "true" : undefined}
        style={{ marginTop: "-1px", touchAction: "none" }}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        {/* Left edge fill — 2px to match the filled track (blue). Anchored
            at top:0 so its top edge aligns with the rail's top edge. */}
        <div
          className="absolute left-0 top-0 h-[2px] w-2 bg-primary-6"
          style={{ opacity: value > 0 ? 1 : 0 }}
        />

        {/* Slider with horizontal margin to prevent handle clipping at edges */}
        <div className="mx-2">
          <Slider
            value={value}
            max={max}
            onValueChange={onValueChange}
            onValueCommit={onValueCommit}
            style={{ width: "100%", padding: 0 }}
            showTooltip={false}
            defaultValue={0}
            noPadding={true}
            disabled={disabled}
            handleBordered={true}
          />
        </div>

        {/* Right edge fill — 1px to match the rail (non-blue). Anchored at
            top:0 so its top edge aligns with the rail's top edge. */}
        <div className="absolute right-0 top-0 h-[1px] w-2 bg-fill-3" />

        {showSegments ? (
          <ReplayTurnTimeline
            segments={segments}
            onSegmentClick={onSegmentClick}
          />
        ) : null}
      </div>
    );
  }
);

ReplayProgressBar.displayName = "ReplayProgressBar";

export default ReplayProgressBar;
