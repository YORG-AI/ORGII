import {
  CalendarClock,
  CalendarDays,
  CalendarOff,
  type LucideIcon,
  Repeat,
  X,
} from "lucide-react";
import React, { useCallback, useMemo, useRef, useState } from "react";

import type { WorkItemSchedule } from "@src/api/http/project";
import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import Select, { type SelectOption } from "@src/components/Select";
import TimePicker from "@src/components/TimePicker";

import { DateQuickAssignDropdown } from "../WorkItemProperties/DateQuickAssignDropdown";
import {
  type CronParts,
  type ScheduleFrequency,
  buildCron,
  parseCron,
} from "./cronUtils";

type ScheduleMode = "none" | "one-shot" | "recurring";
type ScheduleValue = WorkItemSchedule | null;

interface ScheduleEditorProps {
  schedule?: WorkItemSchedule | null;
  onChange: (schedule: ScheduleValue) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
  compact?: boolean;
}

const FREQUENCY_OPTIONS: { value: ScheduleFrequency; labelKey: string }[] = [
  { value: "daily", labelKey: "common:schedule.freq.daily" },
  { value: "weekday", labelKey: "common:schedule.freq.weekday" },
  { value: "weekly", labelKey: "common:schedule.freq.weekly" },
  { value: "monthly", labelKey: "common:schedule.freq.monthly" },
];

// Recurring execution moved to the Routine system ("Routine = recurring,
// work item = tracking"): existing cron schedules are auto-migrated to
// routines at startup; new ones can no longer be created here. The
// "recurring" mode remains readable for legacy values until migration runs.
const MODE_OPTIONS: {
  value: ScheduleMode;
  labelKey: string;
  Icon: LucideIcon;
}[] = [
  { value: "none", labelKey: "common:schedule.noSchedule", Icon: CalendarOff },
  {
    value: "one-shot",
    labelKey: "common:schedule.oneShot",
    Icon: CalendarClock,
  },
];

const WEEKDAY_VALUES = [0, 1, 2, 3, 4, 5, 6] as const;
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function isSingleValue(
  value: string | number | (string | number)[]
): value is string | number {
  return !Array.isArray(value);
}

function formatOneShotDate(date: Date | null, fallback: string): string {
  if (!date) return fallback;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const ScheduleEditor: React.FC<ScheduleEditorProps> = ({
  schedule,
  onChange,
  t,
  compact = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const currentMode: ScheduleMode = useMemo(() => {
    if (!schedule) return "none";
    if (schedule.cron) return "recurring";
    if (schedule.at) return "one-shot";
    return "none";
  }, [schedule]);

  const cronParts: CronParts = useMemo(() => {
    if (schedule?.cron) {
      const parsed = parseCron(schedule.cron);
      if (parsed) return parsed;
    }
    return { frequency: "daily", hour: 9, minute: 0 };
  }, [schedule]);

  const oneShotDate = useMemo(() => {
    if (schedule?.at) return new Date(schedule.at);
    return null;
  }, [schedule]);

  const [oneShotHour, setOneShotHour] = useState(
    oneShotDate ? oneShotDate.getHours() : 9
  );
  const [oneShotMinute, setOneShotMinute] = useState(
    oneShotDate ? oneShotDate.getMinutes() : 0
  );

  const [showCustomCron, setShowCustomCron] = useState(false);
  const [oneShotDateOpen, setOneShotDateOpen] = useState(false);

  const getSelectPopupContainer = useCallback(
    () => containerRef.current ?? document.body,
    []
  );

  const modeOptions = useMemo<SelectOption[]>(() => {
    const base = MODE_OPTIONS.map(({ value, labelKey, Icon }) => ({
      value,
      dataTestId: `work-item-schedule-mode-option-${value}`,
      label: (
        <span className="inline-flex items-center gap-2">
          <Icon size={DROPDOWN_ITEM.iconSize} className="shrink-0" />
          <span className="truncate">{t(labelKey)}</span>
        </span>
      ),
    }));
    // Legacy escape hatch: a not-yet-migrated cron schedule still renders
    // its current value, but "recurring" is not offered for new schedules.
    if (currentMode === "recurring") {
      base.push({
        value: "recurring",
        dataTestId: "work-item-schedule-mode-option-recurring",
        label: (
          <span className="inline-flex items-center gap-2">
            <Repeat size={DROPDOWN_ITEM.iconSize} className="shrink-0" />
            <span className="truncate">{t("common:schedule.recurring")}</span>
          </span>
        ),
      });
    }
    return base;
  }, [t, currentMode]);

  const frequencyOptions = useMemo<SelectOption[]>(
    () =>
      FREQUENCY_OPTIONS.map((option) => ({
        ...option,
        label: t(option.labelKey),
      })),
    [t]
  );

  const weekdayOptions = useMemo<SelectOption[]>(
    () =>
      WEEKDAY_VALUES.map((day) => ({
        value: day,
        label: t(`common:schedule.days.${WEEKDAY_KEYS[day]}`),
      })),
    [t]
  );

  const monthDayOptions = useMemo<SelectOption[]>(
    () =>
      Array.from({ length: 28 }, (_, index) => {
        const day = index + 1;
        return { value: day, label: String(day) };
      }),
    []
  );

  const handleModeChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (!isSingleValue(value)) return;
      const newMode = value as ScheduleMode;
      setOneShotDateOpen(false);
      if (newMode === "none") {
        onChange(null);
      } else if (newMode === "one-shot") {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(oneShotHour, oneShotMinute, 0, 0);
        onChange({ at: tomorrow.toISOString(), enabled: true });
      } else {
        onChange({
          cron: buildCron(cronParts),
          enabled: true,
        });
      }
    },
    [onChange, cronParts, oneShotHour, oneShotMinute]
  );

  const handleOneShotDateChange = useCallback(
    (date: Date | null) => {
      setOneShotDateOpen(false);
      if (!date) {
        onChange(null);
        return;
      }
      date.setHours(oneShotHour, oneShotMinute, 0, 0);
      onChange({ at: date.toISOString(), enabled: true });
    },
    [onChange, oneShotHour, oneShotMinute]
  );

  const handleOneShotTimeChange = useCallback(
    (hour: number, minute: number) => {
      setOneShotHour(hour);
      setOneShotMinute(minute);
      if (oneShotDate) {
        const updated = new Date(oneShotDate);
        updated.setHours(hour, minute, 0, 0);
        onChange({
          at: updated.toISOString(),
          enabled: true,
        });
      }
    },
    [onChange, oneShotDate]
  );

  const handleFrequencyChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (!isSingleValue(value)) return;
      const newParts: CronParts = {
        ...cronParts,
        frequency: value as ScheduleFrequency,
      };
      onChange({
        cron: buildCron(newParts),
        enabled: true,
      });
    },
    [onChange, cronParts]
  );

  const handleCronTimeChange = useCallback(
    (hour: number, minute: number) => {
      const newParts: CronParts = { ...cronParts, hour, minute };
      onChange({
        cron: buildCron(newParts),
        enabled: true,
      });
    },
    [onChange, cronParts]
  );

  const handleDayOfWeekChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (!isSingleValue(value)) return;
      const newParts: CronParts = {
        ...cronParts,
        dayOfWeek: Number(value),
      };
      onChange({
        cron: buildCron(newParts),
        enabled: true,
      });
    },
    [onChange, cronParts]
  );

  const handleDayOfMonthChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (!isSingleValue(value)) return;
      const newParts: CronParts = {
        ...cronParts,
        dayOfMonth: Number(value),
      };
      onChange({
        cron: buildCron(newParts),
        enabled: true,
      });
    },
    [onChange, cronParts]
  );

  const handleCustomCronChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onChange({
        cron: event.target.value,
        enabled: true,
      });
    },
    [onChange]
  );

  const selectProps = {
    size: "small" as const,
    dropdownAlign: "right" as const,
    dropdownWidthMode: "match" as const,
    variant: "ghost" as const,
    className: "w-full",
    getPopupContainer: getSelectPopupContainer,
  };

  return (
    <div ref={containerRef} className={`space-y-3 ${compact ? "p-2" : "p-3"}`}>
      <div>
        <div className="mb-1 text-[11px] font-medium text-text-3">
          {t("common:schedule.scheduleType")}
        </div>
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <Select
              {...selectProps}
              value={currentMode}
              options={modeOptions}
              onChange={handleModeChange}
              dataTestId="work-item-schedule-mode-select"
            />
          </div>
          {schedule && (
            <button
              type="button"
              aria-label={t("common:actions.clear")}
              onClick={() => onChange(null)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-none bg-transparent text-text-3 transition-colors hover:bg-fill-3 hover:text-text-1"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {currentMode === "one-shot" && (
        <div className="space-y-2">
          <div>
            <div className="mb-1 text-[11px] font-medium text-text-3">
              {t("common:common.date")}
            </div>
            <div className="relative">
              <button
                type="button"
                className="flex h-8 w-full items-center gap-2 rounded-lg border border-border-2 bg-bg-2 px-2 text-left text-[12px] text-text-1 outline-none transition-colors hover:bg-fill-2 focus:border-primary-6"
                onClick={() => setOneShotDateOpen((open) => !open)}
              >
                <CalendarDays
                  size={DROPDOWN_ITEM.iconSize}
                  className="shrink-0 text-text-3"
                />
                <span className="min-w-0 flex-1 truncate">
                  {formatOneShotDate(
                    oneShotDate,
                    t("common:common.selectDate")
                  )}
                </span>
              </button>
              {oneShotDateOpen && (
                <DateQuickAssignDropdown
                  value={schedule?.at}
                  onChange={handleOneShotDateChange}
                  t={t}
                  fieldVariant="row"
                />
              )}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium text-text-3">
              {t("common:schedule.time")}
            </div>
            <TimePicker
              hour={oneShotHour}
              minute={oneShotMinute}
              onChange={handleOneShotTimeChange}
              variant="ghost"
            />
          </div>
        </div>
      )}

      {currentMode === "recurring" && (
        <div className="space-y-2">
          <div>
            <div className="mb-1 text-[11px] font-medium text-text-3">
              {t("common:schedule.frequency")}
            </div>
            <Select
              {...selectProps}
              value={cronParts.frequency}
              options={frequencyOptions}
              onChange={handleFrequencyChange}
            />
          </div>

          {cronParts.frequency === "weekly" && (
            <div>
              <div className="mb-1 text-[11px] font-medium text-text-3">
                {t("common:schedule.dayOfWeek")}
              </div>
              <Select
                {...selectProps}
                value={cronParts.dayOfWeek ?? 1}
                options={weekdayOptions}
                onChange={handleDayOfWeekChange}
              />
            </div>
          )}

          {cronParts.frequency === "monthly" && (
            <div>
              <div className="mb-1 text-[11px] font-medium text-text-3">
                {t("common:schedule.dayOfMonth")}
              </div>
              <Select
                {...selectProps}
                value={cronParts.dayOfMonth ?? 1}
                options={monthDayOptions}
                onChange={handleDayOfMonthChange}
              />
            </div>
          )}

          <div>
            <div className="mb-1 text-[11px] font-medium text-text-3">
              {t("common:schedule.time")}
            </div>
            <TimePicker
              hour={cronParts.hour}
              minute={cronParts.minute}
              onChange={handleCronTimeChange}
              variant="ghost"
            />
          </div>

          <div>
            <button
              type="button"
              className="text-[11px] text-primary-6 hover:underline"
              onClick={() => setShowCustomCron(!showCustomCron)}
            >
              {showCustomCron
                ? t("common:schedule.hideCustomCron")
                : t("common:schedule.customCron")}
            </button>
            {showCustomCron && (
              <div className="mt-1">
                <input
                  value={schedule?.cron ?? ""}
                  onChange={handleCustomCronChange}
                  placeholder="0 9 * * 1"
                  className="w-full rounded border border-border-2 bg-bg-2 px-2 py-1 text-[11px] text-text-1 outline-none focus:border-primary-6"
                />
                <div className="mt-0.5 text-[10px] text-text-4">
                  {t("common:schedule.cronHelp")}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {schedule?.last_run && (
        <div className="text-[10px] text-text-4">
          {t("common:schedule.lastRun")}:{" "}
          {new Date(schedule.last_run).toLocaleString()}
        </div>
      )}
    </div>
  );
};

export default ScheduleEditor;
