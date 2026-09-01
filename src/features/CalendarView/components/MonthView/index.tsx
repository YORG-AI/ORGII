/**
 * MonthView Component
 *
 * Displays a single month calendar with spanning multi-day events.
 */
import React, { useMemo } from "react";

import {
  WEEKDAY_NAMES_SHORT,
  getMonthCalendarDays,
  getStartOfDay,
  isSameMonth,
  isToday,
  isWeekend,
  parseDate,
} from "../../config";
import type { CalendarEvent } from "../../types";
import SpanningEventCard from "./SpanningEventCard";

// ============================================
// Types
// ============================================

interface MonthViewProps {
  /** Days to display in the grid (for current focused month) */
  days: Date[];
  /** Current month being viewed */
  currentDate: Date;
  /** Events to display */
  events: CalendarEvent[];
  /** Click handler for events */
  onEventClick?: (event: CalendarEvent) => void;
  /** Click handler for date cells */
  onDateClick?: (date: Date) => void;
  /** Currently selected event ID */
  selectedEventId?: string | null;
  /** Week starts on: 0 = Sunday, 1 = Monday */
  weekStartsOn?: 0 | 1;
}

/** Event positioned within a week row */
interface WeekEvent {
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

const EVENT_HEIGHT = 22;
const EVENT_GAP = 2;
const DAY_NUMBER_HEIGHT = 32;
const MIN_ROW_HEIGHT = 100;
const MAX_VISIBLE_ROWS = 10;

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

function calculateWeekEvents(
  weekDays: Date[],
  events: CalendarEvent[]
): WeekEvent[] {
  const weekStart = getStartOfDay(weekDays[0]);
  const weekEnd = getStartOfDay(weekDays[6]);
  weekEnd.setHours(23, 59, 59, 999);

  const weekEvents = events.filter((event) => {
    const eventStart = getStartOfDay(parseDate(event.startDate));
    const eventEnd = getStartOfDay(parseDate(event.endDate));
    return eventStart <= weekEnd && eventEnd >= weekStart;
  });

  weekEvents.sort((eventA, eventB) => {
    const startA = parseDate(eventA.startDate).getTime();
    const startB = parseDate(eventB.startDate).getTime();
    if (startA !== startB) return startA - startB;
    const durationA = parseDate(eventA.endDate).getTime() - startA;
    const durationB = parseDate(eventB.endDate).getTime() - startB;
    return durationB - durationA;
  });

  const columnRows: number[][] = Array.from({ length: 7 }, () => []);
  const result: WeekEvent[] = [];

  for (const event of weekEvents) {
    const eventStart = getStartOfDay(parseDate(event.startDate));
    const eventEnd = getStartOfDay(parseDate(event.endDate));

    const isContinuation = eventStart < weekStart;
    const startCol = isContinuation
      ? 0
      : getDayColumnIndex(eventStart, weekStart);
    const continuesNext = eventEnd > weekEnd;
    const endCol = continuesNext ? 6 : getDayColumnIndex(eventEnd, weekStart);
    const span = endCol - startCol + 1;

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

const MonthView: React.FC<MonthViewProps> = ({
  currentDate,
  events,
  onEventClick,
  onDateClick,
  selectedEventId,
  weekStartsOn = 1,
}) => {
  // Reorder weekday names based on weekStartsOn
  const orderedWeekdays =
    weekStartsOn === 1
      ? [...WEEKDAY_NAMES_SHORT.slice(1), WEEKDAY_NAMES_SHORT[0]]
      : WEEKDAY_NAMES_SHORT;

  // Get days for the current month grid
  const days = useMemo(
    () => getMonthCalendarDays(currentDate, weekStartsOn),
    [currentDate, weekStartsOn]
  );

  // Split days into weeks
  const weeks: Date[][] = useMemo(() => {
    const result: Date[][] = [];
    for (let index = 0; index < days.length; index += 7) {
      result.push(days.slice(index, index + 7));
    }
    return result;
  }, [days]);

  // Calculate events for each week
  const weekEventsMap = useMemo(() => {
    return weeks.map((week) => calculateWeekEvents(week, events));
  }, [weeks, events]);

  return (
    <div className="flex h-full flex-col">
      {/* Fixed header - Day names */}
      <div className="grid shrink-0 grid-cols-7 border-b border-border-2">
        {orderedWeekdays.map((dayName) => (
          <div
            key={dayName}
            className="py-2 text-center text-xs font-medium text-text-3"
          >
            {dayName}
          </div>
        ))}
      </div>

      {/* Scrollable weeks container */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {weeks.map((week, weekIndex) => {
          const weekEvents = weekEventsMap[weekIndex];
          const maxRow =
            weekEvents.length > 0
              ? Math.max(...weekEvents.map((weekEvent) => weekEvent.row))
              : -1;
          const visibleRows = Math.min(maxRow + 1, MAX_VISIBLE_ROWS);
          const hasMoreEvents = maxRow >= MAX_VISIBLE_ROWS;

          // Calculate dynamic height: day number + events + padding, minimum 100px
          const eventsHeight =
            visibleRows > 0 ? visibleRows * (EVENT_HEIGHT + EVENT_GAP) + 8 : 0;
          const rowHeight = Math.max(
            MIN_ROW_HEIGHT,
            DAY_NUMBER_HEIGHT + eventsHeight
          );

          return (
            <div
              key={weekIndex}
              className="relative grid grid-cols-7 border-b border-border-2"
              style={{ minHeight: rowHeight }}
            >
              {/* Day cells */}
              {week.map((day) => {
                const isInMonth = isSameMonth(day, currentDate);
                const isTodayDate = isToday(day);
                const isWeekendDay = isWeekend(day);

                return (
                  <div
                    key={day.toISOString()}
                    onClick={() => onDateClick?.(day)}
                    className={`flex cursor-pointer flex-col border-r border-border-2 p-1 transition-colors last:border-r-0 hover:bg-fill-1/50 ${
                      isInMonth ? "" : "opacity-40"
                    } ${isWeekendDay ? "bg-bg-3/30" : ""}`}
                  >
                    <div className="flex justify-end">
                      <span
                        className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                          isTodayDate
                            ? "bg-primary-6 font-medium text-white"
                            : "text-text-2"
                        }`}
                      >
                        {day.getDate()}
                      </span>
                    </div>
                  </div>
                );
              })}

              {/* Spanning events overlay */}
              <div
                className="pointer-events-none absolute inset-x-0"
                style={{ top: DAY_NUMBER_HEIGHT }}
              >
                {weekEvents
                  .filter((weekEvent) => weekEvent.row < visibleRows)
                  .map((weekEvent) => (
                    <div
                      key={`${weekEvent.event.id}-${weekIndex}`}
                      className="pointer-events-auto absolute"
                      style={{
                        left: `calc(${(weekEvent.startCol / 7) * 100}% + 2px)`,
                        width: `calc(${(weekEvent.span / 7) * 100}% - 4px)`,
                        top: weekEvent.row * (EVENT_HEIGHT + EVENT_GAP),
                        height: EVENT_HEIGHT,
                      }}
                    >
                      <SpanningEventCard
                        event={weekEvent.event}
                        onClick={onEventClick}
                        isSelected={weekEvent.event.id === selectedEventId}
                        isContinuation={weekEvent.isContinuation}
                        continuesNext={weekEvent.continuesNext}
                      />
                    </div>
                  ))}

                {hasMoreEvents && (
                  <div
                    className="absolute right-1 text-[10px] text-text-3"
                    style={{ top: visibleRows * (EVENT_HEIGHT + EVENT_GAP) }}
                  >
                    +
                    {
                      weekEvents.filter(
                        (weekEvent) => weekEvent.row >= visibleRows
                      ).length
                    }{" "}
                    more
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default MonthView;
