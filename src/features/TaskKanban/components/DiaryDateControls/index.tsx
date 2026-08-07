import { ChevronLeft, ChevronRight } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import { addDays, formatDate } from "@src/features/CalendarView/config";

const DIARY_DAY_OPTION_RANGE = 14;

function getLocalDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLocalDayKey(dayKey: string): Date {
  const [yearPart, monthPart, dayPart] = dayKey.split("-");
  return new Date(
    Number(yearPart),
    Number(monthPart) - 1,
    Number(dayPart),
    0,
    0,
    0,
    0
  );
}

function formatDiaryDayOptionLabel(
  date: Date,
  today: Date,
  translate: (key: string) => string
): string {
  const dayKey = getLocalDayKey(date);
  if (dayKey === getLocalDayKey(today)) {
    return translate("common:relativeDate.today");
  }
  if (dayKey === getLocalDayKey(addDays(today, -1))) {
    return translate("common:relativeDate.yesterday");
  }
  if (dayKey === getLocalDayKey(addDays(today, 1))) {
    return translate("common:relativeDate.tomorrow");
  }
  return formatDate(date, date.getFullYear() !== today.getFullYear());
}

export interface DiaryDateControlsProps {
  date: Date;
  onDateChange: (date: Date) => void;
}

const DiaryDateControls: React.FC<DiaryDateControlsProps> = ({
  date,
  onDateChange,
}) => {
  const { t } = useTranslation("sessions");
  const dayKey = getLocalDayKey(date);

  const dayOptions = useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = [];
    const today = new Date();
    for (
      let dayOffset = -DIARY_DAY_OPTION_RANGE;
      dayOffset <= DIARY_DAY_OPTION_RANGE;
      dayOffset++
    ) {
      const optionDate = addDays(date, dayOffset);
      const value = getLocalDayKey(optionDate);
      const label = formatDiaryDayOptionLabel(optionDate, today, t);
      options.push({
        value,
        label,
        triggerLabel: label,
      });
    }
    return options;
  }, [date, t]);

  const handleDayChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value)) return;
      onDateChange(parseLocalDayKey(String(value)));
    },
    [onDateChange]
  );

  const handlePrevious = useCallback(() => {
    onDateChange(addDays(date, -1));
  }, [date, onDateChange]);

  const handleNext = useCallback(() => {
    onDateChange(addDays(date, 1));
  }, [date, onDateChange]);

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Button
        htmlType="button"
        variant="tertiary"
        size="small"
        iconOnly
        icon={<ChevronLeft size={14} />}
        onClick={handlePrevious}
        title={t("kanban.diary.previousDay")}
      />
      <Select
        value={dayKey}
        options={dayOptions}
        onChange={handleDayChange}
        size="small"
        radius="lg"
        variant="ghost"
        dropdownAlign="right"
        dropdownWidthMode="min-match"
        className="text-[12px]"
        style={{ width: "max-content" }}
      />
      <Button
        htmlType="button"
        variant="tertiary"
        size="small"
        iconOnly
        icon={<ChevronRight size={14} />}
        onClick={handleNext}
        title={t("kanban.diary.nextDay")}
      />
    </div>
  );
};

export default DiaryDateControls;
