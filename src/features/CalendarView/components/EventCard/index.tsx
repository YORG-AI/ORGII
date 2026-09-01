/**
 * EventCard Component
 *
 * Renders a single event on the calendar.
 * Uses shared STATUS_COLORS for consistency with Gantt/Kanban views.
 */
import React from "react";

import SessionHoverCard from "@src/components/SessionHoverCard";
import {
  STATUS_COLORS,
  WORK_ITEM_STATUS_COLOR,
} from "@src/types/core/viewStatus";
import type { WorkItemStatus } from "@src/types/core/workItem";

import type { CalendarEvent, PositionedEvent } from "../../types";

// ============================================
// Types
// ============================================

interface EventCardProps {
  /** Event data */
  event: CalendarEvent | PositionedEvent;
  /** Display variant */
  variant?: "month" | "day" | "week";
  /** Click handler */
  onClick?: (event: CalendarEvent) => void;
  /** Whether this event is selected */
  isSelected?: boolean;
}

// ============================================
// Helper Functions
// ============================================

/** Get color config from WorkItemStatus */
function getEventColor(status?: WorkItemStatus, customColor?: string) {
  if (customColor) {
    return {
      bg: `${customColor}20`,
      text: customColor,
      dot: customColor,
    };
  }

  const colorKey = WORK_ITEM_STATUS_COLOR[status || "backlog"];
  const color = STATUS_COLORS[colorKey];

  return {
    bg: `${color.base}20`,
    text: color.light,
    dot: color.base,
  };
}

// ============================================
// Component
// ============================================

const EventCard: React.FC<EventCardProps> = ({
  event,
  variant = "month",
  onClick,
  isSelected = false,
}) => {
  const handleClick = (clickEvent: React.MouseEvent) => {
    clickEvent.stopPropagation();
    onClick?.(event);
  };

  const colors = getEventColor(event.status, event.color);

  if (variant === "month") {
    return (
      <SessionHoverCard sessionId={event.id} position="right-start">
        <button
          onClick={handleClick}
          className={`group flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs transition-all hover:brightness-110 ${
            isSelected ? "ring-1 ring-primary-6" : ""
          }`}
          style={{
            backgroundColor: colors.bg,
            color: colors.text,
          }}
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: colors.dot }}
          />
          <span className="truncate">{event.title}</span>
        </button>
      </SessionHoverCard>
    );
  }

  // Day/Week view - positioned card
  const positionedEvent = event as PositionedEvent;
  const width =
    positionedEvent.totalColumns > 1
      ? `calc(${100 / positionedEvent.totalColumns}% - 2px)`
      : "calc(100% - 4px)";
  const left =
    positionedEvent.totalColumns > 1
      ? `calc(${(positionedEvent.column / positionedEvent.totalColumns) * 100}% + 2px)`
      : "2px";

  return (
    <SessionHoverCard sessionId={event.id} position="right-start">
      <button
        onClick={handleClick}
        className={`absolute overflow-hidden rounded text-left text-xs transition-all hover:brightness-110 ${
          isSelected ? "ring-1 ring-primary-6" : ""
        }`}
        style={{
          top: `${positionedEvent.top}%`,
          height: `${positionedEvent.height}%`,
          left,
          width,
          minHeight: "20px",
          backgroundColor: colors.bg,
          color: colors.text,
        }}
      >
        <div className="h-full p-1">
          <div className="truncate font-medium">{event.title}</div>
          {event.assignee && (
            <div className="truncate text-[10px] opacity-70">
              {typeof event.assignee === "string"
                ? event.assignee
                : event.assignee.name}
            </div>
          )}
        </div>
      </button>
    </SessionHoverCard>
  );
};

export default EventCard;
