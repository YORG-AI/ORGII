/**
 * DayView Component
 *
 * Displays a single day calendar with time slots.
 */
import React, { useMemo } from "react";

import { formatDate, formatTime, isToday } from "../../config";
import type { CalendarEvent, PositionedEvent } from "../../types";
import EventCard from "../EventCard";

// ============================================
// Types
// ============================================

interface DayViewProps {
  /** Day to display */
  day: Date;
  /** Time slots (e.g., ["00:00", "01:00", ...]) */
  timeSlots: string[];
  /** Positioned events for this day */
  positionedEvents: PositionedEvent[];
  /** All-day events for this day */
  allDayEvents: CalendarEvent[];
  /** Click handler for events */
  onEventClick?: (event: CalendarEvent) => void;
  /** Click handler for time slots */
  onTimeSlotClick?: (date: Date, hour: number) => void;
  /** Currently selected event ID */
  selectedEventId?: string | null;
  /** Hide the day title row when surrounding chrome provides context. */
  hideHeader?: boolean;
}

// ============================================
// Constants
// ============================================

const TIME_COLUMN_WIDTH = 56;
const SLOT_HEIGHT = 48;

// ============================================
// Component
// ============================================

const DayView: React.FC<DayViewProps> = ({
  day,
  timeSlots,
  positionedEvents,
  allDayEvents,
  onEventClick,
  onTimeSlotClick,
  selectedEventId,
  hideHeader = false,
}) => {
  // Calculate current time position
  const currentTimeTop = useMemo(() => {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    return (hours + minutes / 60) * SLOT_HEIGHT;
  }, []);

  // Check if displaying today
  const isTodayView = isToday(day);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {!hideHeader && (
        <div className="flex shrink-0 border-b border-border-2">
          <div className="shrink-0" style={{ width: TIME_COLUMN_WIDTH }} />
          <div className="flex flex-1 items-center justify-center py-3">
            <span className="text-sm font-medium text-text-1">
              {formatDate(day, true)}
            </span>
          </div>
        </div>
      )}

      {/* All-day events row (if any) */}
      {allDayEvents.length > 0 && (
        <div className="flex shrink-0 border-b border-border-2">
          <div
            className="flex shrink-0 items-center justify-center text-[10px] text-text-3"
            style={{ width: TIME_COLUMN_WIDTH }}
          >
            All day
          </div>
          <div className="flex flex-1 flex-col gap-0.5 p-1">
            {allDayEvents.map((event) => (
              <EventCard
                key={event.id}
                event={event}
                variant="month"
                onClick={onEventClick}
                isSelected={event.id === selectedEventId}
              />
            ))}
          </div>
        </div>
      )}

      {/* Scrollable time grid */}
      <div className="relative flex min-h-0 flex-1 overflow-y-auto overflow-x-visible scrollbar-hide">
        {/* Time labels column */}
        <div className="shrink-0" style={{ width: TIME_COLUMN_WIDTH }}>
          {timeSlots.map((slot, index) => (
            <div
              key={slot}
              className="flex items-start justify-end pr-2"
              style={{ height: SLOT_HEIGHT }}
            >
              {index > 0 && (
                <span className="-mt-2 text-[10px] font-semibold text-text-3">
                  {formatTime(index, true)}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Main content area with events */}
        <div className="relative flex-1">
          {/* Time slot backgrounds */}
          {timeSlots.map((slot, slotIndex) => (
            <div
              key={slot}
              onClick={() => onTimeSlotClick?.(day, slotIndex)}
              className="cursor-pointer border-b border-border-2 transition-colors hover:bg-fill-1/50"
              style={{ height: SLOT_HEIGHT }}
            />
          ))}

          {/* Current time indicator */}
          {isTodayView && (
            <div
              className="pointer-events-none absolute left-0 right-0 z-50 flex items-center"
              style={{ top: Math.max(5, currentTimeTop) }}
            >
              <div className="-ml-1 h-2.5 w-2.5 rounded-full bg-red-500" />
              <div className="h-0.5 flex-1 bg-red-500" />
            </div>
          )}

          {/* Events overlay */}
          <div className="absolute inset-0">
            {positionedEvents.map((event) => (
              <EventCard
                key={event.id}
                event={event}
                variant="day"
                onClick={onEventClick}
                isSelected={event.id === selectedEventId}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DayView;
