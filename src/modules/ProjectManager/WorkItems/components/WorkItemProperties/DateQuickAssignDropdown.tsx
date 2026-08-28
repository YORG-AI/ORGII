import React from "react";
import { createPortal } from "react-dom";

import DropdownSearch from "@src/components/Dropdown/DropdownSearch";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import {
  type FieldRowVariant,
  Option,
  SearchableDropdown,
} from "@src/components/PropertyField/PropertyFieldEditable";
import type { DropdownEnginePosition } from "@src/hooks/dropdown";
import {
  Calendar02Icon,
  CalendarRemove01Icon,
  HugeiconsIcon,
} from "@src/icons";
import {
  formatLocalMonthDay,
  isSameLocalDay,
} from "@src/util/data/formatters/date";

import {
  type DateQuickAssignSuggestion,
  buildDateQuickAssignSuggestions,
} from "./dateQuickAssign";
import type { WorkItemPropertyTranslator } from "./types";

interface DateQuickAssignDropdownProps {
  value: string | undefined;
  onChange: (date: Date | null) => void;
  t: WorkItemPropertyTranslator;
  fieldVariant: FieldRowVariant;
  emptyLabel?: string;
  portal?: boolean;
  dropdownRef?: React.RefObject<HTMLDivElement | null>;
  dropdownPosition?: DropdownEnginePosition;
}

function formatSuggestionLabel(
  suggestion: DateQuickAssignSuggestion,
  translate: WorkItemPropertyTranslator
): string {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (isSameLocalDay(suggestion.date, today)) {
    return translate("workItems.properties.today");
  }
  if (isSameLocalDay(suggestion.date, tomorrow)) {
    return translate("workItems.properties.tomorrow");
  }
  if (suggestion.id === "this-friday") {
    return translate("workItems.properties.thisFriday");
  }
  if (suggestion.id === "next-week") {
    return translate("workItems.properties.nextWeek");
  }
  return formatLocalMonthDay(suggestion.date, { locale: undefined });
}

function renderOptions(params: {
  searchQuery: string;
  value: string | undefined;
  onChange: (date: Date | null) => void;
  t: WorkItemPropertyTranslator;
  emptyLabel?: string;
}) {
  const suggestions = buildDateQuickAssignSuggestions(params.searchQuery);
  return (
    <>
      <Option
        icon={
          <HugeiconsIcon
            icon={CalendarRemove01Icon}
            data-icon="calendar-x"
            size={DROPDOWN_ITEM.iconSize}
          />
        }
        label={params.emptyLabel ?? params.t("properties.clearDate")}
        isSelected={!params.value}
        onClick={() => params.onChange(null)}
      />
      {suggestions.map((suggestion) => (
        <Option
          key={suggestion.id}
          icon={
            <HugeiconsIcon
              icon={Calendar02Icon}
              data-icon="calendar-days"
              size={DROPDOWN_ITEM.iconSize}
            />
          }
          label={`${formatSuggestionLabel(suggestion, params.t)} · ${formatLocalMonthDay(suggestion.date, { locale: undefined })}`}
          isSelected={
            params.value
              ? isSameLocalDay(new Date(params.value), suggestion.date)
              : false
          }
          onClick={() => params.onChange(suggestion.date)}
        />
      ))}
    </>
  );
}

export function DateQuickAssignDropdown({
  value,
  onChange,
  t,
  fieldVariant,
  emptyLabel,
  portal = false,
  dropdownRef,
  dropdownPosition,
}: DateQuickAssignDropdownProps) {
  const [searchQuery, setSearchQuery] = React.useState("");

  if (portal && dropdownPosition && dropdownRef) {
    return createPortal(
      <div
        ref={dropdownRef}
        className={`fixed flex flex-col ${DROPDOWN_WIDTHS.wideMenuClass} ${DROPDOWN_CLASSES.panelAnimated}`}
        style={{
          top: dropdownPosition.top,
          left:
            dropdownPosition.right === undefined
              ? dropdownPosition.left
              : undefined,
          right: dropdownPosition.right,
        }}
      >
        <DropdownSearch
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t("properties.addDate")}
          autoFocus
        />
        <div className={DROPDOWN_CLASSES.optionsContainer}>
          {renderOptions({ searchQuery, value, onChange, t, emptyLabel })}
        </div>
      </div>,
      document.body
    );
  }

  return (
    <SearchableDropdown
      placeholder={t("properties.addDate")}
      widthMode={fieldVariant === "pill" ? "menu" : "match-parent"}
      align={fieldVariant === "pill" ? "auto" : "left"}
    >
      {(query) =>
        renderOptions({ searchQuery: query, value, onChange, t, emptyLabel })
      }
    </SearchableDropdown>
  );
}
