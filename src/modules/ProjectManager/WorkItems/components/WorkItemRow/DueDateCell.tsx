import { useCallback } from "react";

import { useDropdownEngine } from "@src/hooks/dropdown";
import { Calendar01Icon, HugeiconsIcon } from "@src/icons";

import { DateQuickAssignDropdown } from "../WorkItemProperties/DateQuickAssignDropdown";

interface DueDateCellProps {
  endDate: string | undefined;
  formattedDate: string;
  colorClass: string;
  emptyLabel: string;
  onDateChange?: (date: Date | null) => void;
  t: (key: string) => string;
  readonly?: boolean;
}

export function DueDateCell({
  endDate,
  formattedDate,
  colorClass,
  emptyLabel,
  onDateChange,
  t,
  readonly = false,
}: DueDateCellProps) {
  const {
    isOpen,
    isPositioned,
    toggle,
    close,
    triggerRef,
    panelRef: dropdownRef,
    panelPosition: dropdownPosition,
  } = useDropdownEngine<HTMLDivElement>({
    gap: 4,
    align: "right",
    placement: "bottom",
  });
  const canEdit = !readonly && !!onDateChange;

  const handleChange = useCallback(
    (date: Date | null) => {
      onDateChange?.(date);
      close();
    },
    [close, onDateChange]
  );

  const trigger = !endDate ? (
    <button
      type="button"
      className={`flex h-6 w-6 items-center justify-center rounded-full border border-solid bg-transparent text-text-3 transition-[border-color,background-color,color] ${
        isOpen
          ? "border-primary-5 bg-primary-1 text-primary-6"
          : "border-transparent hover:border-border-3 hover:bg-fill-3"
      } ${canEdit ? "cursor-pointer" : "cursor-default"}`}
      title={emptyLabel}
      onClick={() => {
        if (canEdit) toggle();
      }}
    >
      <HugeiconsIcon
        icon={Calendar01Icon}
        data-icon="calendar"
        size={14}
        strokeWidth={1.75}
      />
    </button>
  ) : (
    <button
      type="button"
      className={`inline-flex h-7 items-center justify-center rounded-full border border-solid px-2 text-[12px] leading-[18px] font-medium transition-[border-color,background-color,color] ${colorClass} ${
        isOpen
          ? "border-primary-5 bg-primary-1"
          : "border-transparent bg-bg-2 hover:border-border-3 hover:bg-fill-3"
      } ${canEdit ? "cursor-pointer" : "cursor-default"}`}
      title={formattedDate}
      onClick={() => {
        if (canEdit) toggle();
      }}
    >
      {formattedDate}
    </button>
  );

  return (
    <div
      className="relative flex h-7 shrink-0 items-center justify-center"
      onClick={(event) => event.stopPropagation()}
    >
      <div ref={triggerRef} className="flex h-7 items-center justify-center">
        {trigger}
      </div>

      {canEdit && isOpen && isPositioned && (
        <DateQuickAssignDropdown
          value={endDate}
          onChange={handleChange}
          t={t}
          fieldVariant="pill"
          emptyLabel={emptyLabel}
          portal
          dropdownRef={dropdownRef}
          dropdownPosition={dropdownPosition}
        />
      )}
    </div>
  );
}
