/**
 * EventBlockHeader - Reusable header component with optional navigate icon
 */
import React, { useContext } from "react";

import EventNavigateIcon from "./EventNavigateIcon";
import { getEventBlockHeaderClasses } from "./config";
import { InSimulatorReplayContext } from "./inSimulatorReplayContext";
import type { EventBlockHeaderProps } from "./types";

/**
 * Standard header for session event blocks.
 * When `onNavigate` is provided, shows an ArrowUpRight icon on hover.
 * When neither `onClick` nor `onNavigate` is set, cursor stays default.
 *
 * Inside the Simulator (`InSimulatorReplayContext`), the navigate icon
 * is hidden because its action ("jump to this event in the Simulator")
 * points to the current location. The header still toggles collapse.
 */
export const EventBlockHeader: React.FC<EventBlockHeaderProps> = ({
  isCollapsed,
  withHover = true,
  onNavigate,
  children,
  rightContent,
  onClick,
  onMouseEnter,
  onMouseLeave,
  className = "",
}) => {
  const isClickable = !!(onClick || onNavigate);
  const inSimulatorReplay = useContext(InSimulatorReplayContext);
  const showNavigate = !!onNavigate && !inSimulatorReplay;
  const handleClick = () => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    onClick?.();
  };

  return (
    <div
      className={`group/chat-block-header ${getEventBlockHeaderClasses(isCollapsed, withHover, isClickable)} ${className}`}
      onClick={onClick ? handleClick : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Left content */}
      <div className="flex min-w-0 flex-1 items-center gap-2 leading-tight">
        {children}
      </div>

      {/* Right content + navigate icon */}
      {(showNavigate || rightContent) && (
        <div className="flex shrink-0 items-center gap-1 select-none">
          {rightContent}
          {showNavigate && <EventNavigateIcon onClick={onNavigate} />}
        </div>
      )}
    </div>
  );
};

EventBlockHeader.displayName = "EventBlockHeader";

export default EventBlockHeader;
