/**
 * CalendarView Component
 *
 * A reusable calendar component for visualizing events across day, week, and month views.
 *
 * @example
 * ```tsx
 * import CalendarView from "@src/features/CalendarView";
 *
 * <CalendarView
 *   events={events}
 *   onEventClick={(event) => handleClick(event)}
 * />
 * ```
 */
import React, { useCallback, useEffect, useState } from "react";

import DayView from "./components/DayView";
import MonthView from "./components/MonthView";
import CalendarToolbar from "./components/Toolbar";
import WeekView from "./components/WeekView";
import {
  useCalendarEvents,
  useCalendarGrid,
  useCalendarNavigation,
} from "./hooks";
import {
  type CalendarConfig,
  type CalendarEvent,
  type CalendarViewMode,
  DEFAULT_CALENDAR_CONFIG,
} from "./types";

// ============================================
// Types
// ============================================

interface CalendarViewProps {
  /** Array of events to display */
  events: CalendarEvent[];
  /** Default view mode */
  defaultViewMode?: CalendarViewMode;
  /** Callback when an event is clicked */
  onEventClick?: (event: CalendarEvent) => void;
  /** Currently selected event ID */
  selectedEventId?: string | null;
  /** Callback when a date cell is clicked */
  onDateClick?: (date: Date) => void;
  /** Callback when a time slot is clicked (for day/week views) */
  onTimeSlotClick?: (date: Date, hour: number) => void;
  /** Additional className */
  className?: string;
  /** Calendar configuration overrides */
  config?: Partial<CalendarConfig>;
  /** Hide the built-in toolbar when parent chrome owns navigation. */
  hideToolbar?: boolean;
  /** Date controlled by parent chrome. */
  currentDate?: Date;
}

// ============================================
// Component
// ============================================

const CalendarView: React.FC<CalendarViewProps> = ({
  events,
  defaultViewMode = "month",
  onEventClick,
  selectedEventId,
  onDateClick,
  onTimeSlotClick,
  className = "",
  config: configOverrides,
  hideToolbar = false,
  currentDate: controlledCurrentDate,
}) => {
  const [viewMode, setViewMode] = useState<CalendarViewMode>(defaultViewMode);

  // Merge config with defaults
  const config: CalendarConfig = {
    ...DEFAULT_CALENDAR_CONFIG,
    ...configOverrides,
  };

  // Navigation hook
  const { currentDate, goToPrevious, goToNext, goToToday, goToDate } =
    useCalendarNavigation({
      weekStartsOn: config.weekStartsOn,
    });

  useEffect(() => {
    if (controlledCurrentDate) {
      goToDate(controlledCurrentDate);
    }
  }, [controlledCurrentDate, goToDate]);

  // Grid hook
  const { days, timeSlots } = useCalendarGrid({
    viewMode,
    currentDate,
    config,
  });

  // Events hook
  const { positionedEventsForDay, allDayEventsForDay } = useCalendarEvents({
    events,
    viewMode,
    dayStartHour: config.dayStartHour,
    dayEndHour: config.dayEndHour,
  });

  // Navigation handlers
  const handleNavigatePrev = useCallback(() => {
    goToPrevious(viewMode);
  }, [goToPrevious, viewMode]);

  const handleNavigateNext = useCallback(() => {
    goToNext(viewMode);
  }, [goToNext, viewMode]);

  // Render view based on mode
  const renderView = () => {
    switch (viewMode) {
      case "day":
        return (
          <DayView
            day={days[0]}
            timeSlots={timeSlots}
            positionedEvents={positionedEventsForDay(days[0])}
            allDayEvents={allDayEventsForDay(days[0])}
            onEventClick={onEventClick}
            onTimeSlotClick={onTimeSlotClick}
            selectedEventId={selectedEventId}
            hideHeader={hideToolbar}
          />
        );

      case "week":
        return (
          <WeekView
            days={days}
            timeSlots={timeSlots}
            getPositionedEventsForDay={positionedEventsForDay}
            getAllDayEventsForDay={allDayEventsForDay}
            onEventClick={onEventClick}
            onTimeSlotClick={onTimeSlotClick}
            selectedEventId={selectedEventId}
            weekStartsOn={config.weekStartsOn}
            events={events}
          />
        );

      case "month":
      default:
        return (
          <MonthView
            days={days}
            currentDate={currentDate}
            events={events}
            onEventClick={onEventClick}
            onDateClick={onDateClick}
            selectedEventId={selectedEventId}
            weekStartsOn={config.weekStartsOn}
          />
        );
    }
  };

  return (
    <div className={`flex h-full flex-col ${className}`}>
      {!hideToolbar && (
        <CalendarToolbar
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          currentDate={currentDate}
          onNavigatePrev={handleNavigatePrev}
          onNavigateNext={handleNavigateNext}
          onGoToToday={goToToday}
        />
      )}
      <div className="min-h-0 flex-1 overflow-hidden">{renderView()}</div>
    </div>
  );
};

export default CalendarView;

// Re-export types for convenience
export type {
  CalendarConfig,
  CalendarEvent,
  CalendarViewMode,
  PositionedEvent,
} from "./types";
export { DEFAULT_CALENDAR_CONFIG } from "./types";
