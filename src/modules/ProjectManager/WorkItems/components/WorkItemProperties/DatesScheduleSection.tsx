import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import {
  FieldRow,
  type FieldRowVariant,
} from "@src/components/PropertyField/PropertyFieldEditable";
import { Calendar01Icon, HugeiconsIcon, TimeScheduleIcon } from "@src/icons";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

import { DateQuickAssignDropdown } from "./DateQuickAssignDropdown";
import type {
  WorkItemPropertyFieldKey,
  WorkItemPropertyHandlers,
  WorkItemPropertyPicker,
  WorkItemPropertyTranslator,
} from "./types";

interface DatesScheduleSectionProps {
  workItem: WorkItemExtended;
  openPicker: WorkItemPropertyPicker;
  togglePicker: (picker: WorkItemPropertyPicker) => void;
  handlers: WorkItemPropertyHandlers;
  showTime: boolean;
  t: WorkItemPropertyTranslator;
  fieldVariant?: FieldRowVariant;
  visibleFields?: Set<WorkItemPropertyFieldKey>;
}

function renderRelativeTime(
  date: string | undefined,
  showTime: boolean,
  getRelativeTime: (date: string | undefined) => string,
  fieldVariant: FieldRowVariant
) {
  if (!date || !showTime) return undefined;
  return (
    <span
      className={`${fieldVariant === "pill" ? "ml-1" : "ml-auto"} shrink-0 text-[11px] text-text-3`}
    >
      {getRelativeTime(date)}
    </span>
  );
}

export function DatesScheduleSection({
  workItem,
  openPicker,
  togglePicker,
  handlers,
  showTime,
  t,
  fieldVariant = "row",
  visibleFields,
}: DatesScheduleSectionProps) {
  const showStartDate = !visibleFields || visibleFields.has("startDate");
  const showDueDate = !visibleFields || visibleFields.has("date");
  if (!showStartDate && !showDueDate) return null;

  return (
    <>
      {showStartDate && (
        <div
          className={
            fieldVariant === "pill"
              ? "relative flex min-h-7 max-w-[220px] min-w-0 items-center"
              : "relative flex min-h-8 w-full items-center"
          }
        >
          <FieldRow
            icon={
              <HugeiconsIcon
                icon={TimeScheduleIcon}
                data-icon="calendar-clock"
                size={DROPDOWN_ITEM.iconSize}
              />
            }
            value={handlers.formatStartDate(workItem.startDate)}
            isSelected={!!workItem.startDate}
            isActive={openPicker === "startDate"}
            suffix={renderRelativeTime(
              workItem.startDate,
              showTime,
              handlers.getRelativeTime,
              fieldVariant
            )}
            variant={fieldVariant}
            onClear={() => handlers.handleStartDateChange(null)}
            onClick={() => togglePicker("startDate")}
          />
          {openPicker === "startDate" && (
            <DateQuickAssignDropdown
              value={workItem.startDate}
              onChange={handlers.handleStartDateChange}
              t={t}
              fieldVariant={fieldVariant}
            />
          )}
        </div>
      )}

      {showDueDate && (
        <div
          className={
            fieldVariant === "pill"
              ? "relative flex min-h-7 max-w-[220px] min-w-0 items-center"
              : "relative flex min-h-8 w-full items-center"
          }
        >
          <FieldRow
            icon={
              <HugeiconsIcon
                icon={Calendar01Icon}
                data-icon="calendar"
                size={DROPDOWN_ITEM.iconSize}
              />
            }
            value={handlers.formatDueDate(workItem.endDate)}
            isSelected={!!workItem.endDate}
            isActive={openPicker === "date"}
            suffix={renderRelativeTime(
              workItem.endDate,
              showTime,
              handlers.getRelativeTime,
              fieldVariant
            )}
            variant={fieldVariant}
            onClear={() => handlers.handleDateChange(null)}
            onClick={() => togglePicker("date")}
          />
          {openPicker === "date" && (
            <DateQuickAssignDropdown
              value={workItem.endDate}
              onChange={handlers.handleDateChange}
              t={t}
              fieldVariant={fieldVariant}
              emptyLabel={t("workItems.properties.noDueDay")}
            />
          )}
        </div>
      )}
    </>
  );
}
