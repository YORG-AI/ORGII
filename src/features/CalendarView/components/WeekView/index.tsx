/**
 * WeekView Component
 *
 * Displays a single week calendar with:
 * - Multi-day events as spanning horizontal bars (like MonthView)
 * - Time-based events in the time grid below
 */
import React, { useMemo } from "react";

import {
  MONTH_NAMES_SHORT,
  formatTime,
  getStartOfDay,
  isToday,
  isWeekend,
  parseDate,
} from "../../config";
import type { CalendarEvent, PositionedEvent } from "../../types";
import EventCard from "../EventCard";
import SpanningEventCard from "../MonthView/SpanningEventCard";

// ============================================
// Types
// ============================================

interface WeekViewProps {
  /** Days for the week (7 days) */
  days: Date[];
  /** Time slots (e.g., ["00:00", "01:00", ...]) */
  timeSlots: string[];
  /** Get positioned events for a day */
  getPositionedEventsForDay: (date: Date) => PositionedEvent[];
  /** Get all-day events for a day */
  getAllDayEventsForDay: (date: Date) => CalendarEvent[];
  /** Click handler for events */
  onEventClick?: (event: CalendarEvent) => void;
  /** Click handler for time slots */
  onTimeSlotClick?: (date: Date, hour: number) => void;
  /** Currently selected event ID */
  selectedEventId?: string | null;
  /** Week starts on: 0 = Sunday, 1 = Monday */
  weekStartsOn?: 0 | 1;
  /** All events (for spanning calculation) */
  events?: CalendarEvent[];
}

/** Event positioned within a week row for spanning display */
interface WeekSpanEvent {
  event: CalendarEvent;
  startCol: number;
  span: number;
  row: number;
  isContinuation: boolean;
  continuesNext: boolean;
}

// ============================================
// Constants
// ============================================

const TIME_COLUMN_WIDTH = 56;
const SLOT_HEIGHT = 48;
const HEADER_HEIGHT = 56;
const EVENT_ROW_HEIGHT = 22;
const EVENT_GAP = 2;
const MAX_ALL_DAY_ROWS = 5;

// ============================================
// Helpers
// ============================================

function getDayColumnIndex(date: Date, weekStart: Date): number {
  const dayStart = getStartOfDay(date);
  const weekStartDay = getStartOfDay(weekStart);
  const diffMs = dayStart.getTime() - weekStartDay.getTime();
  const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
  return Math.max(0, Math.min(6, diffDays));
}

function calculateSpanningEvents(
  weekDays: Date[],
  events: CalendarEvent[]
): WeekSpanEvent[] {
  if (weekDays.length < 7) return [];

  const weekStart = getStartOfDay(weekDays[0]);
  const weekEnd = getStartOfDay(weekDays[6]);
  weekEnd.setHours(23, 59, 59, 999);

  // Filter events that overlap with this week and are multi-day or all-day
  const spanningEvents = events.filter((event) => {
    const eventStart = getStartOfDay(parseDate(event.startDate));
    const eventEnd = getStartOfDay(parseDate(event.endDate));

    // Check if event overlaps with this week
    if (eventStart > weekEnd || eventEnd < weekStart) return false;

    // Include all-day events OR multi-day events
    return event.allDay || eventStart.getTime() !== eventEnd.getTime();
  });

  // Sort by start date, then by duration (longest first)
  spanningEvents.sort((eventA, eventB) => {
    const startA = parseDate(eventA.startDate).getTime();
    const startB = parseDate(eventB.startDate).getTime();
    if (startA !== startB) return startA - startB;
    const durationA = parseDate(eventA.endDate).getTime() - startA;
    const durationB = parseDate(eventB.endDate).getTime() - startB;
    return durationB - durationA;
  });

  // Track which rows are occupied for each column
  const columnRows: number[][] = Array.from({ length: 7 }, () => []);
  const result: WeekSpanEvent[] = [];

  for (const event of spanningEvents) {
    const eventStart = getStartOfDay(parseDate(event.startDate));
    const eventEnd = getStartOfDay(parseDate(event.endDate));

    const isContinuation = eventStart < weekStart;
    const startCol = isContinuation
      ? 0
      : getDayColumnIndex(eventStart, weekStart);
    const continuesNext = eventEnd > weekEnd;
    const endCol = continuesNext ? 6 : getDayColumnIndex(eventEnd, weekStart);
    const span = endCol - startCol + 1;

    // Find first available row
    let row = 0;
    let foundRow = false;
    while (!foundRow) {
      foundRow = true;
      for (let col = startCol; col <= endCol; col++) {
        if (columnRows[col].includes(row)) {
          foundRow = false;
          row++;
          break;
        }
      }
    }

    // Mark row as occupied for these columns
    for (let col = startCol; col <= endCol; col++) {
      columnRows[col].push(row);
    }

    result.push({
      event,
      startCol,
      span,
      row,
      isContinuation,
      continuesNext,
    });
  }

  return result;
}

// ============================================
// Main Component
// ============================================

const WeekView: React.FC<WeekViewProps> = ({
  days,
  timeSlots,
  getPositionedEventsForDay,
  onEventClick,
  onTimeSlotClick,
  selectedEventId,
  events = [],
}) => {
  // Calculate spanning events for this week
  const spanningEvents = useMemo(
    () => calculateSpanningEvents(days, events),
    [days, events]
  );

  // Calculate all-day row height
  const maxRow =
    spanningEvents.length > 0
      ? Math.max(...spanningEvents.map((spanEvent) => spanEvent.row))
      : -1;
  const visibleRows = Math.min(maxRow + 1, MAX_ALL_DAY_ROWS);
  const hasMoreEvents = maxRow >= MAX_ALL_DAY_ROWS;
  const allDayHeight =
    visibleRows > 0 ? visibleRows * (EVENT_ROW_HEIGHT + EVENT_GAP) + 8 : 0;

  // Calculate current time position
  const currentTimeTop = useMemo(() => {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    return (hours + minutes / 60) * SLOT_HEIGHT;
  }, []);

  // Find today's column index
  const todayColumnIndex = useMemo(() => {
    return days.findIndex((day) => isToday(day));
  }, [days]);

  // Grid template for consistent column widths
  const gridStyle = {
    display: "grid",
    gridTemplateColumns: `${TIME_COLUMN_WIDTH}px repeat(7, 1fr)`,
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header Row - Time label + Day headers */}
      <div className="shrink-0 border-b border-border-2" style={gridStyle}>
        {/* Time column header */}
        <div
          className="flex items-center justify-center border-r border-border-2"
          style={{ height: HEADER_HEIGHT }}
        />

        {/* Day headers */}
        {days.map((day) => {
          const isTodayDate = isToday(day);
          const isFirstOfMonth = day.getDate() === 1;
          const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
            day.getDay()
          ];

          return (
            <div
              key={day.toISOString()}
              className="flex flex-col items-center justify-center border-r border-border-2 last:border-r-0"
              style={{ height: HEADER_HEIGHT }}
            >
              <span
                className={`text-xs ${isTodayDate ? "text-primary-6" : "text-text-3"}`}
              >
                {isFirstOfMonth && (
                  <span className="text-primary-6">
                    {MONTH_NAMES_SHORT[day.getMonth()]}{" "}
                  </span>
                )}
                {dayName}
              </span>
              <span
                className={`mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-sm font-medium ${
                  isTodayDate ? "bg-primary-6 text-white" : "text-text-1"
                }`}
              >
                {day.getDate()}
              </span>
            </div>
          );
        })}
      </div>

      {/* All-day Row */}
      {allDayHeight > 0 && (
        <div
          className="relative shrink-0 border-b border-border-2"
          style={gridStyle}
        >
          {/* Time column - All day label */}
          <div
            className="flex items-center justify-center border-r border-border-2 text-[10px] text-text-3"
            style={{ height: allDayHeight }}
          >
            All day
          </div>

          {/* Day columns background */}
          {days.map((day) => (
            <div
              key={`allday-${day.toISOString()}`}
              className={`border-r border-border-2 last:border-r-0 ${
                isWeekend(day) ? "bg-bg-3/30" : ""
              }`}
              style={{ height: allDayHeight }}
            />
          ))}

          {/* Spanning events - positioned absolutely over the grid */}
          <div
            className="pointer-events-none absolute"
            style={{
              left: TIME_COLUMN_WIDTH,
              right: 0,
              top: 0,
              height: allDayHeight,
            }}
          >
            {spanningEvents
              .filter((spanEvent) => spanEvent.row < MAX_ALL_DAY_ROWS)
              .map((spanEvent) => (
                <div
                  key={`span-${spanEvent.event.id}`}
                  className="pointer-events-auto absolute"
                  style={{
                    left: `calc(${(spanEvent.startCol / 7) * 100}% + 2px)`,
                    width: `calc(${(spanEvent.span / 7) * 100}% - 4px)`,
                    top: spanEvent.row * (EVENT_ROW_HEIGHT + EVENT_GAP) + 4,
                    height: EVENT_ROW_HEIGHT,
                  }}
                >
                  <SpanningEventCard
                    event={spanEvent.event}
                    onClick={onEventClick}
                    isSelected={spanEvent.event.id === selectedEventId}
                    isContinuation={spanEvent.isContinuation}
                    continuesNext={spanEvent.continuesNext}
                  />
                </div>
              ))}

            {/* More indicator */}
            {hasMoreEvents && (
              <div
                className="pointer-events-auto absolute right-2 text-[10px] text-text-3"
                style={{ bottom: 2 }}
              >
                +
                {
                  spanningEvents.filter(
                    (spanEvent) => spanEvent.row >= MAX_ALL_DAY_ROWS
                  ).length
                }{" "}
                more
              </div>
            )}
          </div>
        </div>
      )}

      {/* Scrollable Time Grid */}
      <div className="relative scrollbar-hide min-h-0 flex-1 overflow-y-auto">
        <div style={gridStyle}>
          {/* Time labels column */}
          <div>
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

          {/* Day columns */}
          {days.map((day, dayIndex) => {
            const positionedEvents = getPositionedEventsForDay(day);
            const isWeekendDay = isWeekend(day);
            const isTodayColumn = dayIndex === todayColumnIndex;

            // Filter out events that are already shown as spanning
            const timeEvents = positionedEvents.filter((positionedEvent) => {
              const eventStart = getStartOfDay(
                parseDate(positionedEvent.startDate)
              );
              const eventEnd = getStartOfDay(
                parseDate(positionedEvent.endDate)
              );
              // Only show if NOT all-day and NOT multi-day
              return (
                !positionedEvent.allDay &&
                eventStart.getTime() === eventEnd.getTime()
              );
            });

            return (
              <div
                key={`grid-${day.toISOString()}`}
                className={`relative border-r border-border-2 last:border-r-0 ${
                  isWeekendDay ? "bg-bg-3/30" : ""
                }`}
              >
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
                {isTodayColumn && (
                  <div
                    className="pointer-events-none absolute right-0 left-0 z-50 flex items-center"
                    style={{ top: Math.max(5, currentTimeTop) }}
                  >
                    <div className="-ml-1 h-2.5 w-2.5 rounded-full bg-red-500" />
                    <div className="h-0.5 flex-1 bg-red-500" />
                  </div>
                )}

                {/* Time-based events overlay */}
                <div className="absolute inset-0">
                  {timeEvents.map((event) => (
                    <EventCard
                      key={event.id}
                      event={event}
                      variant="week"
                      onClick={onEventClick}
                      isSelected={event.id === selectedEventId}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default WeekView;
