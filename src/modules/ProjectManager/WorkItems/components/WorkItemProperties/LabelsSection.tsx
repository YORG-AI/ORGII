import { Tag } from "lucide-react";

import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import {
  FieldRow,
  type FieldRowVariant,
  Option,
  SearchableDropdown,
} from "@src/components/PropertyField/PropertyFieldEditable";
import type {
  WorkItem as WorkItemExtended,
  WorkItemLabel,
} from "@src/types/core/workItem";

import type {
  WorkItemPropertyHandlers,
  WorkItemPropertyPicker,
  WorkItemPropertyTranslator,
} from "./types";

interface LabelsSectionProps {
  workItem: WorkItemExtended;
  openPicker: WorkItemPropertyPicker;
  togglePicker: (picker: WorkItemPropertyPicker) => void;
  availableLabels: WorkItemLabel[];
  handlers: WorkItemPropertyHandlers;
  t: WorkItemPropertyTranslator;
  fieldVariant?: FieldRowVariant;
}

export function LabelsSection({
  workItem,
  openPicker,
  togglePicker,
  availableLabels,
  handlers,
  t,
  fieldVariant = "row",
}: LabelsSectionProps) {
  return (
    <div
      className={
        fieldVariant === "pill"
          ? "relative flex min-h-7 min-w-0 max-w-[220px] items-center"
          : "relative flex min-h-8 w-full items-center"
      }
    >
      <FieldRow
        icon={<Tag size={DROPDOWN_ITEM.iconSize} />}
        value={
          workItem.labels && workItem.labels.length > 0
            ? workItem.labels.map((label) => label.name).join(", ")
            : t("workItems.properties.noLabels")
        }
        isSelected={!!workItem.labels && workItem.labels.length > 0}
        isActive={openPicker === "labels"}
        variant={fieldVariant}
        onClear={handlers.handleLabelsClear}
        onClick={() => togglePicker("labels")}
      />
      {openPicker === "labels" && (
        <SearchableDropdown
          placeholder={t("common:actions.search")}
          widthMode={fieldVariant === "pill" ? "menu" : "match-parent"}
          align={fieldVariant === "pill" ? "auto" : "left"}
        >
          {(searchQuery) => {
            const filtered = searchQuery
              ? availableLabels.filter((label) =>
                  label.name.toLowerCase().includes(searchQuery.toLowerCase())
                )
              : availableLabels;
            return filtered.map((label) => {
              const isSelected = workItem.labels?.some(
                (item) => item.id === label.id
              );
              return (
                <Option
                  key={label.id}
                  label={label.name}
                  isSelected={isSelected}
                  onClick={() => handlers.handleLabelToggle(label)}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: label.color }}
                  />
                  <span className="flex-1 truncate">{label.name}</span>
                </Option>
              );
            });
          }}
        </SearchableDropdown>
      )}
    </div>
  );
}
